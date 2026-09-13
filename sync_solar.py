# =============================================================
# sync_solar.py  —  Coleta dados do inversor SAJ via Elekeeper
# Versão 3.0  —  13/09/2026
# =============================================================
# HISTÓRICO:
#   v3.0 (13/09/2026)
#     - REESCRITO DO ZERO a partir do código-fonte real da biblioteca
#       pysaj-elekeeper v0.0.10 (baixado e inspecionado diretamente:
#       elekeeper/client.py e elekeeper/crypto.py), adaptado de
#       async (httpx) para síncrono (requests).
#     - CAUSA RAIZ do errCode 10001 identificada: os endpoints de
#       dados (getDeviceEneryFlowData, getPlantStatisticsData) são
#       GET, não POST. O v2.8 chamava com POST e URLs /api/v2/...
#       que não existem na biblioteca de referência.
#     - Endpoints corrigidos para os reais (todos GET, sob /api/v1):
#         GET /monitor/home/getDeviceEneryFlowData   (nota: "Enery")
#         GET /monitor/home/getPlantStatisticsData
#       Ambos recebem plantUid + deviceSn como query params assinados.
#     - Adicionada resolução automática do deviceSn via
#       GET /monitor/plant/getOnePlantInfo (a biblioteca usa isso
#       internamente antes de chamar os endpoints "home").
#     - Assinatura (signed_params) copiada linha a linha do
#       crypto.py real — sem os campos extras (clientCode, orgCode,
#       themeColor) que o v2.8 inventou e que não existem na
#       implementação de referência.
#     - Checagem de erro agora usa o campo real "errCode" (0 = ok),
#       com fallback para "connOk" por segurança.
#     - Base URL continua iop.saj-electric.com (biblioteca usa eop
#       por padrão — o portal do usuário é iop, então mantemos as
#       chaves alternativas de token: tokenValue, token, accessToken).
#
#   (histórico anterior v2.0–v2.8 removido por brevidade — a lógica
#    de criptografia AES da senha e a extração alternativa de token
#    permanecem herdadas dessas versões, pois já estavam corretas)
#
# VARIÁVEIS DE AMBIENTE (GitHub Secrets):
#   SAJ_USER      — email do Elekeeper
#   SAJ_PASS      — senha em texto puro (script criptografa com AES)
#   SUPABASE_URL  — URL do projeto Supabase
#   SUPABASE_KEY  — chave service role do Supabase
#   SAJ_PLANT_UID — UID da planta (opcional, tem default)
# =============================================================

import os
import sys
import json
import time
import hashlib
import random
import requests
from datetime import date, datetime

try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
except ImportError:
    print("ERRO: instale pycryptodome: pip install pycryptodome")
    sys.exit(1)


# ── Constantes do Elekeeper ────────────────────────────────────
# Extraídas diretamente de elekeeper/crypto.py e elekeeper/client.py
# (pysaj-elekeeper v0.0.10, inspecionado no wheel oficial do PyPI)

BASE_URL          = "https://iop.saj-electric.com"   # portal do usuário (biblioteca usa eop por padrão)
API_BASE          = f"{BASE_URL}/dev-api"
APP_PROJECT_NAME  = "elekeeper"
CLIENT_ID         = "esolar-monitor-admin"
SIGNATURE_SECRET  = "ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe"
PASSWORD_AES_KEY  = bytes.fromhex("ec1840a7c53cf0709eb784be480379b6")
RANDOM_ALPHABET   = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
LANGUAGE          = "pt"

# Estados do inversor (usado só para fallback de exibição)
ESTADOS = {0: "Offline", 1: "Normal", 2: "Alarme", 3: "Falha"}


# ── Credenciais (somente via variáveis de ambiente) ────────────
def get_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"ERRO: variável de ambiente '{name}' não definida.")
        sys.exit(1)
    return val

SAJ_USER     = get_env("SAJ_USER")
SAJ_PASS     = get_env("SAJ_PASS")
SUPABASE_URL = get_env("SUPABASE_URL")
SUPABASE_KEY = get_env("SUPABASE_KEY")
PLANT_UID    = os.environ.get("SAJ_PLANT_UID", "2952D7851F7147278195F923618A0741")


# ── Criptografia / assinatura (copiado de elekeeper/crypto.py) ─

def encrypt_password(password: str) -> str:
    """AES-128-ECB + PKCS7, igual ao frontend Elekeeper. Retorna hex string."""
    cipher = AES.new(PASSWORD_AES_KEY, AES.MODE_ECB)
    padded = pad(password.encode("utf-8"), AES.block_size)
    return cipher.encrypt(padded).hex()


def random_token(length: int = 32) -> str:
    return "".join(random.choice(RANDOM_ALPHABET) for _ in range(length))


def timestamp_ms() -> int:
    return int(time.time() * 1000)


def is_empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def compact_mapping(values: dict) -> dict:
    """Remove campos vazios recursivamente — igual ao frontend."""
    compacted = {}
    for key, value in values.items():
        if isinstance(value, dict):
            value = compact_mapping(value)
        elif isinstance(value, list):
            value = [item for item in value if not is_empty(item)]
        if not is_empty(value):
            compacted[key] = value
    return compacted


def common_params() -> dict:
    return {
        "appProjectName": APP_PROJECT_NAME,
        "clientDate":     date.today().isoformat(),
        "lang":           LANGUAGE,
        "timeStamp":      timestamp_ms(),
        "random":         random_token(),
    }


def signed_params(params=None, sign_only_common: bool = False) -> dict:
    """
    Réplica exata de elekeeper.crypto.signed_params().
    Login assina só os campos comuns (sign_only_common=True);
    os demais endpoints assinam o payload completo.
    """
    common = common_params()
    request_params = compact_mapping({**(params or {}), **common})
    signature_source = compact_mapping(common if sign_only_common else dict(request_params))

    signature_source.pop("confirmPassword", None)
    signature_source.pop("rememberMe", None)
    signature_source.pop("uuid", None)
    signature_source["clientId"] = CLIENT_ID

    keys = list(signature_source)
    canonical = "&".join(sorted(f"{k}={signature_source[k]}" for k in keys))
    md5_hex   = hashlib.md5(f"{canonical}&key={SIGNATURE_SECRET}".encode(), usedforsecurity=False).hexdigest()
    signature = hashlib.sha1(md5_hex.encode("utf-8"), usedforsecurity=False).hexdigest().upper()

    return {
        **request_params,
        "appProjectName": APP_PROJECT_NAME,
        "clientId":       CLIENT_ID,
        "signParams":     ",".join(keys),
        "signature":      signature,
        "timeStamp":      common["timeStamp"],
        "clientDate":     common["clientDate"],
        "random":         common["random"],
    }


# ── Cliente Elekeeper (síncrono, requests) ─────────────────────

class ElekeeperClient:
    """Cliente HTTP síncrono para https://iop.saj-electric.com/dev-api."""

    def __init__(self):
        self.session = requests.Session()
        self.token = None

    def _headers(self, auth: bool = True) -> dict:
        headers = {
            "Content-Language": "zh_CN",
            "Content-Type":     "application/x-www-form-urlencoded;charset=UTF-8",
            "enableSign":       "false",
            "lang":             LANGUAGE,
        }
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _request(self, method: str, path: str, params=None,
                 auth: bool = True, sign_only_common: bool = False) -> dict:
        """
        Réplica de elekeeper.client.SajClient._request(), mas síncrona.
        IMPORTANTE: GET envia os params assinados na query string;
        POST envia como corpo form-urlencoded. O v2.8 errava aqui,
        usando POST para tudo.
        """
        signed  = signed_params(params, sign_only_common=sign_only_common)
        headers = self._headers(auth=auth)
        url     = f"{API_BASE}{path}"

        try:
            if method.upper() == "GET":
                resp = self.session.get(url, params=signed, headers=headers, timeout=30)
            elif method.upper() == "POST":
                resp = self.session.post(url, data=signed, headers=headers, timeout=30)
            else:
                raise ValueError(f"Método não suportado: {method}")
        except requests.Timeout:
            raise Exception(f"Timeout ao chamar {path}")
        except requests.ConnectionError as e:
            raise Exception(f"Erro de conexão em {path}: {e}")

        if resp.status_code == 401:
            raise Exception(f"Token expirado ou inválido (401) em {path}")
        if resp.status_code != 200:
            raise Exception(f"HTTP {resp.status_code} em {path}: {resp.text[:300]}")

        try:
            payload = resp.json()
        except Exception:
            raise Exception(f"Resposta não é JSON em {path}: {resp.text[:300]}")

        # Campo de erro real da API é "errCode" (0 = sucesso).
        # Mantemos fallback em "connOk" observado no portal iop.
        err_code = payload.get("errCode", 0)
        if err_code not in (0, None):
            err_msg = payload.get("errMsg") or payload.get("fallbackMsg") or "Erro desconhecido"
            raise Exception(f"Elekeeper recusou {path} (errCode={err_code}): {err_msg}")
        if payload.get("connOk") is False:
            err_msg = payload.get("errMsg") or payload.get("fallbackMsg") or "Erro desconhecido"
            raise Exception(f"Elekeeper recusou {path}: {err_msg}")

        return payload.get("data") or {}

    def login(self) -> None:
        """
        POST /api/v1/sys/login — assina só os campos comuns
        (sign_only_common=True), igual à biblioteca de referência.
        """
        data = self._request(
            "POST",
            "/api/v1/sys/login",
            {
                "username":   SAJ_USER,
                "password":   encrypt_password(SAJ_PASS),
                "rememberMe": False,
                "loginType":  1,
            },
            auth=False,
            sign_only_common=True,
        )

        # A biblioteca de referência (portal eop) usa data["token"].
        # O portal iop do usuário retorna data["tokenValue"] — mantemos
        # ambas as chaves e outros fallbacks já validados por DevTools.
        token = (
            data.get("tokenValue")
            or data.get("token")
            or data.get("accessToken")
            or data.get("access_token")
            or data.get("originToken")
        )
        if token in (None, "", "null"):
            raise Exception(f"Token não encontrado na resposta de login: {json.dumps(data)[:300]}")

        self.token = token
        print(f"✅ Login OK — token obtido ({token[:30]}...)")

    def get_primary_device_sn(self, plant_uid: str):
        """
        GET /api/v1/monitor/plant/getOnePlantInfo — usado pela biblioteca
        para obter o deviceSn antes de chamar os endpoints 'home'.
        Retorna None se não encontrar (os endpoints toleram deviceSn ausente).
        """
        try:
            data = self._request("GET", "/api/v1/monitor/plant/getOnePlantInfo", {"plantUid": plant_uid})
        except Exception as e:
            print(f"   ⚠️  Não foi possível obter deviceSn ({e}) — seguindo sem ele")
            return None

        device_sns = data.get("deviceSnList") or []
        if device_sns:
            return str(device_sns[0])
        for device in data.get("devices") or []:
            if isinstance(device, dict) and device.get("deviceSn"):
                return str(device["deviceSn"])
        return None

    def get_flow(self, plant_uid: str, device_sn) -> dict:
        """GET /api/v1/monitor/home/getDeviceEneryFlowData (nota: 'Enery', não 'Energy')."""
        data = self._request(
            "GET",
            "/api/v1/monitor/home/getDeviceEneryFlowData",
            {"plantUid": plant_uid, "deviceSn": device_sn},
        )
        print(f"   getDeviceEneryFlowData resposta: {json.dumps(data)[:500]}")
        return data

    def get_plant_stats(self, plant_uid: str, device_sn) -> dict:
        """GET /api/v1/monitor/home/getPlantStatisticsData."""
        data = self._request(
            "GET",
            "/api/v1/monitor/home/getPlantStatisticsData",
            {"plantUid": plant_uid, "deviceSn": device_sn},
        )
        print(f"   getPlantStatisticsData resposta: {json.dumps(data)[:500]}")
        return data


# ── Gravar no Supabase ─────────────────────────────────────────

def gravar_supabase(flow: dict, stats: dict) -> None:
    """Grava dados na tabela solar_geracao via REST API do Supabase."""

    total_kwh = None
    cum = stats.get("totalPvEnergy") or stats.get("cumulativeEnergy")
    if cum is not None:
        try:
            total_kwh = float(cum)
        except (ValueError, TypeError):
            total_kwh = None

    hoje_kwh = flow.get("todayPvEnergy")
    if hoje_kwh is None:
        hoje_kwh = stats.get("todayPvEnergy")

    registro = {
        "plant_uid":           PLANT_UID,
        "potencia_atual_w":    flow.get("totalPvPower") or flow.get("solarPower") or stats.get("powerNow"),
        "geracao_hoje_kwh":    hoje_kwh,
        "geracao_total_kwh":   total_kwh,
        "estado":              flow.get("runningStateName") or stats.get("userModeName") or
                               ESTADOS.get(flow.get("runningState", 0), "Desconhecido"),
        "estado_cod":          flow.get("runningState"),
        "potencia_sistema_kw": flow.get("systemPower"),
        "atualizado_em":       flow.get("updateDate") or stats.get("dataTime"),
        "raw_flow":            flow,
        "raw_stats":           stats,
    }
    registro_limpo = {k: v for k, v in registro.items() if v is not None}

    url = f"{SUPABASE_URL}/rest/v1/solar_geracao"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "return=minimal",
    }
    resp = requests.post(url, json=registro_limpo, headers=headers, timeout=30)

    if resp.status_code not in (200, 201):
        raise Exception(f"Supabase HTTP {resp.status_code}: {resp.text[:200]}")

    print(
        f"✅ Supabase OK — "
        f"Potência: {registro.get('potencia_atual_w')}W | "
        f"Hoje: {registro.get('geracao_hoje_kwh')} kWh | "
        f"Total: {total_kwh} kWh | "
        f"Estado: {registro.get('estado')}"
    )


# ── Main com retry ─────────────────────────────────────────────

def main():
    print(f"\n{'='*60}")
    print(f"☀️  Sync Solar SAJ — {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print(f"{'='*60}")
    print(f"   Portal:    iop.saj-electric.com")
    print(f"   Planta:    {PLANT_UID}")
    print(f"   Usuário:   {SAJ_USER}")

    max_tentativas = 3
    for tentativa in range(1, max_tentativas + 1):
        try:
            print(f"\n🔄 Tentativa {tentativa}/{max_tentativas}")

            client = ElekeeperClient()
            client.login()

            print("🔎 Resolvendo deviceSn da planta...")
            device_sn = client.get_primary_device_sn(PLANT_UID)
            print(f"   deviceSn: {device_sn or '(não encontrado — seguindo sem ele)'}")

            print("📡 Buscando fluxo de energia...")
            flow = client.get_flow(PLANT_UID, device_sn)
            if not flow:
                print("⚠️  Inversor offline ou sem geração — registrando estado")
                flow = {"runningState": 0, "runningStateName": "Offline",
                        "totalPvPower": 0, "todayPvEnergy": None}

            print("📊 Buscando estatísticas da planta...")
            stats = client.get_plant_stats(PLANT_UID, device_sn)

            print(f"\n☀️  Potência atual:  {flow.get('totalPvPower', '--')} W")
            print(f"☀️  Geração hoje:    {flow.get('todayPvEnergy', stats.get('todayPvEnergy', '--'))} kWh")
            print(f"☀️  Total acumulado: {stats.get('totalPvEnergy', '--')} kWh")
            print(f"☀️  Estado:          {flow.get('runningStateName', '--')}")
            print(f"☀️  Última leitura:  {flow.get('updateDate', '--')}")

            try:
                gravar_supabase(flow, stats)
                print(f"\n✅ Concluído com sucesso!")
            except Exception as db_err:
                print(f"\n⚠️  Dados coletados mas erro ao gravar no Supabase: {db_err}")
                print("   Verifique se SUPABASE_URL e SUPABASE_KEY estão nos Secrets do GitHub")
            return

        except Exception as e:
            print(f"\n❌ Erro na tentativa {tentativa}: {e}")
            if tentativa < max_tentativas:
                espera = tentativa * 15
                print(f"⏳ Aguardando {espera}s antes de tentar novamente...")
                time.sleep(espera)
            else:
                print(f"\n💥 Todas as {max_tentativas} tentativas falharam.")
                sys.exit(1)


if __name__ == "__main__":
    main()
