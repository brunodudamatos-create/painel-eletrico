# =============================================================
# sync_solar.py  —  Coleta dados do inversor SAJ via Elekeeper
# Versão 2.8  —  09/09/2026
# =============================================================
# HISTÓRICO:
#   v2.8 (09/09/2026)
#     - CORREÇÃO CRÍTICA baseada no código fonte pysaj-elekeeper v0.0.10:
#       Content-Type: form-urlencoded em TODOS os endpoints (não JSON)
#       enableSign: false — x-sign NÃO é necessário
#       data= em todos os POSTs (não json=)
#       Isso corrige errCode 10001 nos endpoints autenticados
#   v2.7 (09/09/2026)
#     - Supabase: substituído supabase-py por REST API direta
#       Resolve [Errno -2] Name or service not known no GitHub Actions
#       Usa requests (já instalado) + apikey header
#   v2.6 (09/09/2026)
#     - Headers obrigatórios adicionados (confirmados pelo DevTools):
#       x-app-project-name, x-client-code, x-org-code, x-lang,
#       x-theme-color, content-language, x-client-date, x-timestamp
#       Esses headers são exigidos pelos endpoints v2 autenticados
#     - Erro Supabase isolado: falha DNS não interrompe mais o loop
#       Verifica se SUPABASE_URL/KEY estão nos Secrets do GitHub
#   v2.5 (09/09/2026)
#     - Adicionado log da resposta completa dos endpoints
#       para diagnosticar por que retorna vazio durante o dia
#   v2.4 (09/09/2026)
#     - flow vazio não é mais erro: inversor offline (noite) é normal
#       Grava registro com potência 0 e estado Offline para histórico
#   v2.3 (09/09/2026)
#     - Extração do token corrigida para estrutura real do iop:
#       data.tokenValue (campo principal) com fallbacks para
#       data.token, data.accessToken, data.originToken
#       Filtra tokens vazios ("" ou "null")
#   v2.2 (09/09/2026)
#     - Login corrigido: usa form-encoded (data=) em vez de JSON
#       A biblioteca pysaj-elekeeper usa data= no POST de login
#       Servidor rejeita JSON com errCode 10003 "loginType null"
#   v2.1 (09/09/2026)
#     - Login: removido sign_only_common=True, assina payload completo
#     - loginType e rememberMe enviados como string (igual ao browser)
#     - Corrige errCode 10003: "Login type can't be null"
#   v2.0 (09/09/2026)
#     - Chaves JSON confirmadas com dados reais capturados pelo DevTools
#     - Login via iop.saj-electric.com/dev-api/api/v1/sys/login
#     - Coleta via iop.saj-electric.com/dev-api/api/v2/...
#     - AES-128-ECB para senha + MD5+SHA1 para assinatura
#     - raw_flow e raw_stats gravados em JSONB para auditoria
#     - Retry automático em caso de falha no login ou coleta
#     - Todos os campos com .get() + default — sem KeyError
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

# Supabase via REST API direta (mais confiável que supabase-py no GitHub Actions)
# Não precisa de biblioteca externa — usa requests que já está instalado


# ── Constantes do Elekeeper ────────────────────────────────────
# Extraídas da biblioteca open-source pysaj-elekeeper (MIT)
# e validadas contra o portal iop.saj-electric.com

BASE_URL_V1       = "https://iop.saj-electric.com/dev-api/api/v1"
BASE_URL_V2       = "https://iop.saj-electric.com/dev-api/api/v2"
APP_PROJECT_NAME  = "elekeeper"
CLIENT_ID         = "esolar-monitor-admin"
SIGNATURE_SECRET  = "ktoKRLgQPjvNyUZO8lVc9kU1Bsip6XIe"
PASSWORD_AES_KEY  = bytes.fromhex("ec1840a7c53cf0709eb784be480379b6")
RANDOM_ALPHABET   = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"

# Estados do inversor
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


# ── Funções de criptografia ────────────────────────────────────

def encrypt_password(password: str) -> str:
    """
    Criptografa a senha com AES-128-ECB + PKCS7 padding.
    Mesmo algoritmo do frontend Elekeeper (chave: ec1840a7c53cf0709eb784be480379b6).
    Retorna hex string.
    """
    cipher = AES.new(PASSWORD_AES_KEY, AES.MODE_ECB)
    padded = pad(password.encode("utf-8"), AES.block_size)
    return cipher.encrypt(padded).hex()


def random_token(length: int = 32) -> str:
    """Gera o campo 'random' da requisição usando o alfabeto do Elekeeper."""
    return "".join(random.choice(RANDOM_ALPHABET) for _ in range(length))


def timestamp_ms() -> int:
    """Timestamp em milissegundos (campo timeStamp das requisições)."""
    return int(time.time() * 1000)


def sign_params(params: dict, sign_only_common: bool = False) -> dict:
    """
    Monta e assina o payload da requisição.

    Algoritmo (extraído do crypto.py da pysaj-elekeeper):
      1. Une params + common fields (appProjectName, clientDate, etc.)
      2. Remove campos vazios (None, "", [], {})
      3. Ordena as chaves alfabeticamente → "k1=v1&k2=v2&..."
      4. Concatena "&key=SECRET"
      5. MD5 do resultado
      6. SHA1 do MD5 → uppercase = assinatura final (campo 'signature')

    O campo 'signParams' lista as chaves que foram assinadas (para o servidor validar).
    """
    ts    = timestamp_ms()
    rand  = random_token()
    today = date.today().isoformat()

    common = {
        "appProjectName": APP_PROJECT_NAME,
        "clientDate":     today,
        "lang":           "pt",
        "timeStamp":      ts,
        "random":         rand,
    }

    # Remove campos vazios — o frontend faz isso antes de assinar
    def is_empty(v):
        return v is None or v == "" or v == [] or v == {}

    merged = {k: v for k, v in {**params, **common}.items() if not is_empty(v)}

    # Fonte da assinatura: só common fields (login) ou payload completo (demais)
    sig_src = dict(common if sign_only_common else merged)
    sig_src.pop("confirmPassword", None)
    sig_src.pop("rememberMe",      None)
    sig_src.pop("uuid",            None)
    sig_src["clientId"] = CLIENT_ID

    # Ordenar e concatenar
    canonical = "&".join(sorted(f"{k}={v}" for k, v in sig_src.items()))
    full_str  = f"{canonical}&key={SIGNATURE_SECRET}"

    # MD5 → SHA1 → uppercase
    md5_hex   = hashlib.md5(full_str.encode(), usedforsecurity=False).hexdigest()
    signature = hashlib.sha1(md5_hex.encode("utf-8"), usedforsecurity=False).hexdigest().upper()

    return {
        **merged,
        # Campos obrigatórios em TODAS as requisições
        "appProjectName": APP_PROJECT_NAME,
        "clientId":       CLIENT_ID,
        "clientCode":     "organization",
        "orgCode":        "saj",
        "themeColor":     "dark",
        "signParams":     ",".join(sig_src.keys()),
        "signature":      signature,
        "timeStamp":      ts,
        "clientDate":     today,
        "random":         rand,
    }


# ── Cliente Elekeeper ──────────────────────────────────────────

class ElekeeperClient:
    """Cliente HTTP para o portal iop.saj-electric.com."""

    def __init__(self):
        self.session = requests.Session()
        self.token   = None
        # Headers confirmados pelo código fonte da biblioteca pysaj-elekeeper v0.0.10
        # Content-Type é form-urlencoded em TODOS os endpoints (não JSON)
        # enableSign: false — x-sign NÃO é necessário
        self.session.headers.update({
            "Content-Type":    "application/x-www-form-urlencoded;charset=UTF-8",
            "Content-Language": "zh_CN",
            "enableSign":      "false",
            "lang":            "pt",
        })

    def _post(self, base: str, endpoint: str, payload: dict) -> dict:
        """POST autenticado com tratamento completo de erros."""
        url = f"{base}{endpoint}"
        headers = dict(self.session.headers)
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        try:
            # data= envia como form-urlencoded (obrigatório para iop.saj-electric.com)
            resp = self.session.post(url, data=payload, headers=headers, timeout=30)
        except requests.Timeout:
            raise Exception(f"Timeout ao chamar {endpoint}")
        except requests.ConnectionError as e:
            raise Exception(f"Erro de conexão em {endpoint}: {e}")

        if resp.status_code == 401:
            raise Exception(f"Token expirado ou inválido (401) em {endpoint}")
        if resp.status_code != 200:
            raise Exception(f"HTTP {resp.status_code} em {endpoint}: {resp.text[:200]}")

        try:
            data = resp.json()
        except Exception:
            raise Exception(f"Resposta não é JSON em {endpoint}: {resp.text[:200]}")

        # Verificar campo connOk (padrão do Elekeeper)
        conn_ok = data.get("connOk")
        if conn_ok is False:
            err = data.get("errMsg") or data.get("fallbackMsg") or "Erro desconhecido"
            raise Exception(f"Elekeeper recusou {endpoint}: {err}")

        return data

    def login(self) -> None:
        """
        Faz login no Elekeeper e armazena o JWT.

        Endpoint: POST /dev-api/api/v1/sys/login
        Payload:
          - username: email do usuário
          - password: senha criptografada com AES-128-ECB
          - rememberMe: false
          - loginType: 1

        O token pode estar em:
          - resp.cookies["Authorization"]  (mais comum no iop)
          - resp.headers["Authorization"]
          - data["result"]["token"]
          - data["result"] (string direta)
        """
        # Login: assina o payload completo (não só common fields)
        # O iop.saj-electric.com exige loginType no corpo assinado
        payload = sign_params({
            "username":   SAJ_USER,
            "password":   encrypt_password(SAJ_PASS),
            "rememberMe": "false",   # string como o browser envia
            "loginType":  "1",       # string como o browser envia
        })

        url  = f"{BASE_URL_V1}/sys/login"
        headers = dict(self.session.headers)
        resp = self.session.post(url, data=payload, headers=headers, timeout=30)

        if resp.status_code not in (200, 201):
            raise Exception(f"Login HTTP {resp.status_code}: {resp.text[:300]}")

        data = resp.json()

        if data.get("connOk") is False:
            raise Exception(f"Login recusado: {data.get('errMsg')}")

        # Extrair token — estrutura real do iop.saj-electric.com:
        # {"data": {"expiresIn": 259200, "originToken": "...", 
        #            "refreshToken": "...", "tokenValue": "...",
        #            "tokenName": "Authorization"}, "errCode": 0}
        token = None

        # 1. data.tokenValue (campo principal do iop v2)
        data_obj = data.get("data") or {}
        if isinstance(data_obj, dict):
            token = (data_obj.get("tokenValue") or
                     data_obj.get("token") or
                     data_obj.get("accessToken") or
                     data_obj.get("access_token") or
                     data_obj.get("originToken") or
                     data_obj.get("refreshToken"))
            # Filtrar tokens vazios
            if token == "" or token == "null":
                token = None

        # 2. result direto (formato antigo eop)
        if not token:
            result = data.get("result")
            if isinstance(result, dict):
                token = (result.get("token") or
                         result.get("tokenValue") or
                         result.get("access_token"))
            elif isinstance(result, str) and len(result) > 20:
                token = result

        # 3. Cookie
        if not token:
            token = resp.cookies.get("Authorization") or resp.cookies.get("token")

        # 4. Header Authorization
        if not token:
            auth_header = resp.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header.replace("Bearer ", "")

        if not token:
            raise Exception(
                f"Token não encontrado. Resposta completa: {json.dumps(data)}\n"
                f"Cookies: {dict(resp.cookies)}\n"
                f"Headers: {dict(resp.headers)}"
            )

        self.token = token
        self.session.headers["Authorization"] = f"Bearer {token}"
        print(f"✅ Login OK — token obtido ({token[:30]}...)")

    def get_flow(self) -> dict:
        """
        Busca fluxo de energia em tempo real.
        Endpoint: POST /dev-api/api/v2/monitor/home/getDeviceEnergyFlowDiagram
        """
        payload = sign_params({"plantUid": PLANT_UID})
        data    = self._post(BASE_URL_V2, "/monitor/home/getDeviceEnergyFlowDiagram", payload)
        print(f"   getDeviceEnergyFlowDiagram resposta: {json.dumps(data)[:500]}")
        return data.get("data") or {}

    def get_plant_stats(self) -> dict:
        """
        Busca estatísticas da planta (geração total acumulada).
        Endpoint: POST /dev-api/api/v2/monitor/plant/getPlantListStats
        """
        hoje = date.today().isoformat()
        payload = sign_params({
            "pageNo":         1,
            "pageSize":       10,
            "keyWordType":    "1",
            "queryDateType":  1,
            "queryStartDate": hoje,
            "queryEndDate":   hoje,
        })
        data  = self._post(BASE_URL_V2, "/monitor/plant/getPlantListStats", payload)
        print(f"   getPlantListStats resposta: {json.dumps(data)[:500]}")
        lista = (data.get("data") or {}).get("list") or []
        return lista[0] if lista else {}


# ── Gravar no Supabase ─────────────────────────────────────────

def gravar_supabase(flow: dict, stats: dict) -> None:
    """Grava dados na tabela solar_geracao via REST API do Supabase."""

    total_kwh = None
    cum = stats.get("cumulativeEnergy")
    if cum is not None:
        try:
            total_kwh = float(cum)
        except (ValueError, TypeError):
            total_kwh = None

    registro = {
        "plant_uid":           PLANT_UID,
        "potencia_atual_w":    flow.get("totalPvPower"),
        "geracao_hoje_kwh":    flow.get("todayPvEnergy"),
        "geracao_total_kwh":   total_kwh,
        "estado":              flow.get("runningStateName") or
                               ESTADOS.get(flow.get("runningState", 0), "Desconhecido"),
        "estado_cod":          flow.get("runningState"),
        "potencia_sistema_kw": flow.get("systemPower"),
        "atualizado_em":       flow.get("updateDate"),
        "raw_flow":            flow,
        "raw_stats":           stats,
    }
    registro_limpo = {k: v for k, v in registro.items() if v is not None}

    # REST API direta — mais confiável que supabase-py no GitHub Actions
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

            print("📡 Buscando fluxo de energia...")
            flow = client.get_flow()
            if not flow:
                # Inversor offline (noite/nublado) — normal fora do horário solar
                # Gravar registro com potência 0 para manter histórico contínuo
                print("⚠️  Inversor offline ou sem geração — registrando estado")
                flow = {"runningState": 0, "runningStateName": "Offline",
                        "totalPvPower": 0, "todayPvEnergy": None}

            print("📊 Buscando estatísticas da planta...")
            stats = client.get_plant_stats()
            # stats pode ser vazio em alguns horários — não é erro crítico

            print(f"\n☀️  Potência atual:  {flow.get('totalPvPower', '--')} W")
            print(f"☀️  Geração hoje:    {flow.get('todayPvEnergy', '--')} kWh")
            print(f"☀️  Total acumulado: {stats.get('cumulativeEnergy', '--')} kWh")
            print(f"☀️  Estado:          {flow.get('runningStateName', '--')}")
            print(f"☀️  Última leitura:  {flow.get('updateDate', '--')}")

            try:
                gravar_supabase(flow, stats)
                print(f"\n✅ Concluído com sucesso!")
            except Exception as db_err:
                print(f"\n⚠️  Dados coletados mas erro ao gravar no Supabase: {db_err}")
                print("   Verifique se SUPABASE_URL e SUPABASE_KEY estão nos Secrets do GitHub")
            return  # Sai do loop — coleta foi bem-sucedida

        except Exception as e:
            print(f"\n❌ Erro na tentativa {tentativa}: {e}")
            if tentativa < max_tentativas:
                espera = tentativa * 15  # 15s, 30s entre tentativas
                print(f"⏳ Aguardando {espera}s antes de tentar novamente...")
                time.sleep(espera)
            else:
                print(f"\n💥 Todas as {max_tentativas} tentativas falharam.")
                sys.exit(1)


if __name__ == "__main__":
    main()
