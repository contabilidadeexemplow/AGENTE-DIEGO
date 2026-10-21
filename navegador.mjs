// O navegador do servidor e a entrada no SIARE.
//
// Regras herdadas do robo-campo e do MAGNU:
// - um navegador NOVO por pedido, com perfil vazio: sessão reaproveitada vaza
//   o produtor anterior;
// - o login só vale quando o topo do SIARE mostra a IE do produtor do pedido;
// - senha recusada NUNCA é tentada de novo sozinha: três recusas bloqueiam a
//   conta. Depois de uma recusa, aquela IE fica 30 minutos sem tentativa.
//
// Duas formas de entrar:
// - "assistido" (só no PC, com janela): a pessoa digita a senha. Este código
//   nunca vê a senha;
// - "cofre" (servidor): a senha vem do segredo SIARE_CREDENCIAIS do Render.
//   Ela só é digitada no campo do SIARE: não vai para log, evidência nem API.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE = 'https://www2.fazenda.mg.gov.br';
export const LOGIN = BASE + '/sol/ctrl/SOL/GERAL/INICIAL_INTERNET?ACAO=VISUALIZAR';

export function acharNavegador(preferido = '') {
  const local = process.env.LOCALAPPDATA || '';
  const candidatos = [
    preferido,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    local && `${local}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidatos.find((c) => existsSync(c)) || null;
}

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const digitos = (s) => String(s ?? '').replace(/\D/g, '');

export async function abrirNavegador({ semJanela = false, executavel = '' } = {}) {
  const caminho = acharNavegador(executavel);
  if (!caminho) throw new Error('Não achei o navegador (Chrome, Edge ou Chromium) nesta máquina.');
  const perfil = mkdtempSync(join(tmpdir(), 'agro-facil-'));
  const navegador = await puppeteer.launch({
    executablePath: caminho,
    headless: semJanela,
    userDataDir: perfil,
    defaultViewport: semJanela ? { width: 1280, height: 900 } : null,
    protocolTimeout: 300000,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-popup-blocking',
      // Rastreador da SEF-MG que segura o onload das telas intermediárias.
      '--host-resolver-rules=MAP eum.instana.io 127.0.0.1',
      // No container: sem sandbox de usuário e sem o /dev/shm de 64 MB.
      ...(semJanela ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  const fechar = async () => {
    await navegador.close().catch(() => undefined);
    try { rmSync(perfil, { recursive: true, force: true }); } catch { /* o Windows pode segurar o perfil por um instante */ }
  };
  const [aberta] = await navegador.pages();
  const page = aberta || (await navegador.newPage());
  // Sem janela, o navegador se anuncia como HeadlessChrome; o SIARE vê um Chrome comum.
  if (semJanela) await page.setUserAgent((await navegador.userAgent()).replace('HeadlessChrome', 'Chrome'));
  return { navegador, page, fechar };
}

/**
 * Avisos do SIARE. alert sempre se aceita (só avisa). confirm é a pergunta
 * antes de uma ação: recusado, a não ser que a pessoa já tenha confirmado o
 * pedido no AGRO FÁCIL (`podeConfirmar()` verdadeiro, depois do /confirmar).
 */
export function tratarDialogos(page, registrar, podeConfirmar = () => false) {
  page.on('dialog', (d) => {
    const sim = d.type() !== 'confirm' || podeConfirmar();
    registrar(`O SIARE perguntou: "${d.message().slice(0, 160)}" → ${sim ? 'sim' : 'não'}`);
    (sim ? d.accept() : d.dismiss()).catch(() => undefined);
  });
}

// Tokens numéricos do texto da página, só com dígitos ("002344737.00-09" → "0023447370009").
async function lerTela(page) {
  const r = await page
    .evaluate(() => {
      const s = document.querySelector('[name="senhaAtual"]');
      return { texto: (document.body && document.body.innerText) || '', temSenha: !!(s && s.offsetParent) };
    })
    .catch(() => ({ texto: '', temSenha: true }));
  return { ...r, numeros: (r.texto.match(/\d[\d.\-/]{6,}\d/g) || []).map(digitos) };
}

/** Na tela de login? (Para não guardar print dela.) */
export async function naTelaDeLogin(page) {
  return (await lerTela(page)).temSenha;
}

const recusas = new Map(); // IE → até quando não tentar de novo
const PAUSA_RECUSA_MS = 30 * 60000;

/** Entra no SIARE com o produtor do pedido e confere a IE na tela. */
export async function entrarNoSiare(page, produtor, { credencial = null, semJanela = false, etapa, cancelado = () => false, tetoMs = 5 * 60000 }) {
  const ie = digitos(produtor.ie);
  const automatico = produtor.acesso === 'cofre' || produtor.acesso === 'substabelecido';
  if (automatico && !credencial) {
    throw new Error('A senha deste produtor não está guardada no servidor. Peça para incluí-la no segredo SIARE_CREDENCIAIS.');
  }
  if (!automatico && semJanela) {
    throw new Error('Este produtor está como "digita a senha". No servidor, mude para "Senha guardada no servidor" em Ajustes.');
  }
  const bloqueio = recusas.get(ie);
  if (automatico && bloqueio && bloqueio > Date.now()) {
    const min = Math.ceil((bloqueio - Date.now()) / 60000);
    throw new Error(`O SIARE recusou a senha desta IE há pouco. Para não bloquear a conta, nova tentativa só em ${min} min.`);
  }

  etapa('Abrindo o SIARE');
  await page.goto(LOGIN, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('[name="cmbDominio"]', { timeout: 60000 }).catch(() => {
    throw new Error('A tela de entrada do SIARE não abriu. O portal pode estar fora do ar.');
  });

  // Tipo de acesso, IE e CPF; a senha só no modo automático.
  await page
    .evaluate(
      (ie, cpf, senha, dominio) => {
        const sel = document.querySelector('[name="cmbDominio"]');
        if (sel) {
          const alvo = String(dominio || 'Produtor Rural').toLowerCase();
          const opt = Array.from(sel.options).find((o) => (o.text || '').trim().toLowerCase() === alvo) || Array.from(sel.options).find((o) => /produtor rural/i.test(o.text));
          if (opt) {
            sel.value = opt.value;
            // Só o evento do jQuery liga o campo da IE (tratarCMBDominio).
            if (window.jQuery) window.jQuery(sel).trigger('change');
            else sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        const campo = (n) => document.querySelector(`[name="${n}"]`);
        if (campo('dominio')) campo('dominio').value = ie;
        if (campo('login')) campo('login').value = cpf;
        if (senha && campo('senhaAtual')) campo('senhaAtual').value = senha;
        else if (campo('senhaAtual')) campo('senhaAtual').focus();
      },
      ie,
      digitos(credencial ? credencial.cpf : produtor.cpf),
      automatico ? credencial.senha : '',
      credencial ? credencial.dominio : 'Produtor Rural',
    )
    .catch(() => undefined);

  if (automatico) {
    etapa('Entrando no SIARE');
    await dormir(600);
    await page.evaluate(() => {
      const b = document.querySelector('input[name="Entrar"][type="button"]') || document.querySelector('input[value="Entrar"]') || document.querySelector('button[type="submit"]');
      if (b) b.click();
    });
  } else {
    etapa('Esperando você entrar no SIARE na janela que abriu');
  }

  // Automático: 30 s (o portal às vezes demora). Assistido: o tempo da pessoa.
  const ate = Date.now() + (automatico ? 30000 : tetoMs);
  while (Date.now() < ate) {
    if (cancelado()) throw new Error('Pedido desistido antes da entrada no SIARE.');
    const { texto, temSenha, numeros } = await lerTela(page);
    if (/ESTAMOS EM MANUTEN/i.test(texto)) throw new Error('O SIARE está em manutenção. Tente mais tarde.');
    if (automatico && /inv[áa]lid|incorret|bloquead|n[ãa]o confere|senha expirad/i.test(texto)) {
      recusas.set(ie, Date.now() + PAUSA_RECUSA_MS);
      const frase = (texto.split('\n').map((s) => s.trim()).find((s) => /inv[áa]lid|incorret|bloquead|n[ãa]o confere|senha expirad/i.test(s)) || '').slice(0, 160);
      throw new Error('O SIARE recusou o acesso' + (frase ? `: "${frase}"` : '.') + ' Nada foi feito e não haverá nova tentativa automática.');
    }
    const foraDoLogin = !temSenha && !/efetue o login/i.test(texto);
    if (foraDoLogin && numeros.includes(ie)) {
      recusas.delete(ie);
      return;
    }
    // O topo mostra "IE : CPF". Se aparece uma IE (13 dígitos) que não é a do
    // pedido, entrou o produtor errado.
    if (foraDoLogin && numeros.some((n) => n.length === 13)) {
      throw new Error('A entrada no SIARE não é da IE deste pedido. Por segurança, nada foi feito.');
    }
    await dormir(1500);
  }
  throw new Error(automatico ? 'O SIARE não confirmou a entrada em 30 segundos. Nada foi feito.' : 'A entrada no SIARE não foi feita a tempo.');
}

// Lê um PDF usando a sessão da própria página. Evita o visualizador do Chrome,
// que entrega o PDF uma vez só e, com page.pdf(), sai em branco.
export async function baixarPdf(page, url) {
  const r = await page.evaluate(async (u) => {
    const resp = await fetch(u, { credentials: 'include' });
    const tipo = resp.headers.get('content-type') || '';
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { tipo, base64: btoa(bin), texto: tipo.includes('pdf') ? '' : new TextDecoder('iso-8859-1').decode(buf).slice(0, 4000) };
  }, url);
  if (!/pdf/i.test(r.tipo)) return { pdf: null, html: r.texto };
  return { pdf: Buffer.from(r.base64, 'base64') };
}

// Sessão caída: o aviso "efetue o login" ou a própria caixa de entrada (tipo de
// usuário + senha). Uma tela interna aberta depois da queda volta para a página
// inicial pública, sem o aviso (visto em 15/10/2026).
export async function pedeLogin(page) {
  return page
    .evaluate(() => /efetue o login/i.test((document.body && document.body.innerText) || '') || !!(document.querySelector('[name="senhaAtual"]') && document.querySelector('[name="cmbDominio"]')))
    .catch(() => false);
}
