// Entrada com código de acesso. A pessoa digita o código uma vez; o servidor
// devolve um cookie assinado (HttpOnly, SameSite=Strict) que vale 30 dias.
// Sem CODIGO_ACESSO (no PC), tudo fica aberto, como sempre foi.
//
// Como robô de um cliente da PONTE, a porta é outra: o servidor do site manda
// SEGREDO_DO_SITE no cabeçalho x-agro-facil-segredo. Com o segredo definido e
// sem código, NINGUÉM mais entra — nem quem achar o endereço do Render.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const NOME = 'af_sessao';
const VALIDADE_MS = 30 * 24 * 3600 * 1000;
const TENTATIVAS = 5;
const JANELA_MS = 10 * 60000;

const igual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function criarSessoes({ codigoAcesso, segredoSessao, segredoDoSite = '' }) {
  // Sem segredo fixo, um por processo: as sessões caem quando o servidor reinicia.
  const segredo = segredoSessao || randomBytes(32).toString('hex');
  const tentativas = new Map();
  const assinar = (ate) => createHmac('sha256', segredo).update('agro-facil:' + ate).digest('base64url');

  function lerCookie(req) {
    const bruto = req.headers.cookie || '';
    for (const parte of bruto.split(';')) {
      const [k, ...v] = parte.trim().split('=');
      if (k === NOME) return v.join('=');
    }
    return '';
  }

  return {
    ligada: !!codigoAcesso || !!segredoDoSite,
    /** O pedido traz uma sessão válida? (Sem código e sem segredo do site, sempre.) */
    valida(req) {
      if (segredoDoSite && igual(req.headers['x-agro-facil-segredo'] || '', segredoDoSite)) return true;
      if (!codigoAcesso) return !segredoDoSite;
      const [ate, assinatura] = lerCookie(req).split('.');
      if (!ate || !assinatura || Number(ate) < Date.now()) return false;
      return igual(assinatura, assinar(ate));
    },
    /** Confere o código. Devolve o cabeçalho Set-Cookie, ou o motivo da recusa. */
    entrar(req, codigo) {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const agora = Date.now();
      const t = tentativas.get(ip);
      if (t && t.ate > agora && t.n >= TENTATIVAS) return { erro: 'muitas', status: 429 };
      if (!codigoAcesso || !igual(codigo || '', codigoAcesso)) {
        const n = t && t.ate > agora ? t.n + 1 : 1;
        tentativas.set(ip, { n, ate: t && t.ate > agora ? t.ate : agora + JANELA_MS });
        return { erro: 'codigo', status: 401 };
      }
      tentativas.delete(ip);
      const ate = String(agora + VALIDADE_MS);
      const https = req.headers['x-forwarded-proto'] === 'https';
      const cookie = `${NOME}=${ate}.${assinar(ate)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${VALIDADE_MS / 1000}${https ? '; Secure' : ''}`;
      return { cookie };
    },
    sair: () => `${NOME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  };
}
