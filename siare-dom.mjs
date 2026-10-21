// Ajudantes de página do SIARE, compartilhados pelas cordas que ESCREVEM
// (emissão, alteração...). Toda ação segue o GUIA-SIARE §1: o formulário é o
// document.formTela e os botões chamam genericOnClick(form, valida, url, ACAO).
import { BASE } from './navegador.mjs';

export const SOL = BASE + '/sol/ctrl/SOL';
export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export async function esperarCampo(page, seletor, tetoMs = 30000) {
  const ate = Date.now() + tetoMs;
  while (Date.now() < ate) {
    const achou = await page.evaluate((s) => !!document.querySelector(s), seletor).catch(() => false);
    if (achou) { await dormir(300); return true; }
    await dormir(400);
  }
  return false;
}

/** Erro que o SIARE mostra na própria tela (a tela de erro repete o cabeçalho). */
export async function lerErro(page) {
  return page.evaluate(() => {
    const txt = (document.body && document.body.innerText) || '';
    if (!/Ação inválida|Sess(ã|a)o expirad|valores inválidos|não foi poss|obrigat/i.test(txt)) return '';
    const cantos = document.querySelectorAll('[id*=etalhe],[class*=etalhe],[id*=erro],[class*=erro],ul,ol');
    for (const el of cantos) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && /inválid|obrigat|deverá|necess|não pode|expirad/i.test(t)) return t.slice(0, 220);
    }
    const linha = txt.split('\n').map((s) => s.trim()).find((s) => /inválid|obrigat|deverá|necess|não pode|expirad/i.test(s));
    return (linha || '').slice(0, 220);
  });
}

/** Campo de texto. Para data/hora passe semChange=true (o validador reage ao change). */
export async function texto(page, nome, valor, semChange = false) {
  if (valor == null || valor === '') return;
  await page.evaluate((n, v, sc) => {
    const el = document.querySelector(`[name="${n}"]`);
    if (!el || el.disabled || el.readOnly) return;
    el.value = v;
    if (!sc) el.dispatchEvent(new Event('change', { bubbles: true }));
  }, nome, String(valor), semChange);
}

/** Radio pelo value (ou campo oculto). */
export async function radio(page, nome, valor) {
  if (valor == null || valor === '') return;
  await page.evaluate((n, v) => {
    const el = document.querySelector(`[name="${n}"][value="${v}"]`) || document.querySelector(`[name="${n}"]`);
    if (!el) return;
    if (el.type === 'radio') { el.checked = true; el.dispatchEvent(new Event('click', { bubbles: true })); }
    else { el.value = v; }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, nome, String(valor));
}

/**
 * Rádio cujo clique pode RECARREGAR a tela (ex.: Transporte: recarregarTipoTransporte,
 * recarregarJaContratado, atualizar). Já marcado: não clica. Senão clica como a
 * pessoa e espera a recarga (sem ela, o próximo passo cruza com o envio e o SIARE
 * volta para a tela inicial — visto em 15/10/2026).
 */
export async function radioComRecarga(page, nome, valor, prova, esperaMs = 6000) {
  if (valor == null || valor === '') return;
  const v = String(valor);
  const ja = await page.evaluate((n, x) => !!(document.querySelector(`[name="${n}"][value="${x}"]`) || {}).checked, nome, v).catch(() => false);
  if (ja) return;
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: esperaMs }).catch(() => null);
  const achou = await page.evaluate((n, x) => {
    const el = document.querySelector(`[name="${n}"][value="${x}"]`);
    if (!el || el.disabled) return false;
    setTimeout(() => el.click(), 0);
    return true;
  }, nome, v).catch(() => true);
  if (!achou) return;
  await nav;
  if (prova && !(await esperarCampo(page, prova, 20000))) throw new Error(await ondeParou(page));
}

/** <select> comum: casa pelo código; senão por texto (igual→começa→contém). */
export async function selecionar(page, nome, valor) {
  if (valor == null || valor === '') return;
  await page.evaluate((n, v) => {
    const sel = document.querySelector(`select[name="${n}"]`);
    if (!sel) return;
    const alvo = String(v).trim().toLowerCase();
    const op = Array.from(sel.options);
    const achar = op.find((o) => o.value.trim().toLowerCase() === alvo)
      || op.find((o) => (o.text || '').trim().toLowerCase() === alvo)
      || op.find((o) => (o.text || '').trim().toLowerCase().startsWith(alvo))
      || op.find((o) => (o.text || '').trim().toLowerCase().includes(alvo));
    if (achar) { sel.value = achar.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, nome, String(valor));
}

/** <select> cujas opções vêm mascaradas (ex.: IE "001234567.00-89"): casa pelos dígitos. */
export async function selecionarPorDigitos(page, nome, valor) {
  const alvo = String(valor ?? '').replace(/\D/g, '');
  if (!alvo) return false;
  return page.evaluate((n, a) => {
    const sel = document.querySelector(`select[name="${n}"]`);
    if (!sel) return false;
    const so = (s) => String(s || '').replace(/\D/g, '');
    const op = Array.from(sel.options).find((o) => so(o.value) === a || so(o.text) === a);
    if (!op) return false;
    sel.value = op.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, nome, alvo);
}

/** jquery.selectbox (cmbGrupo/cmbOrigem/cmbUnidadeMedida): seta o select escondido
 *  + jQuery; se o widget estilizado não "pegar", clica no <span> da opção. */
export async function selectbox(page, nome, valor) {
  if (valor == null || valor === '') return;
  await page.evaluate((n, v) => {
    const sel = document.querySelector(`select[name="${n}"]`);
    if (!sel) return;
    const alvo = String(v).trim().toLowerCase();
    const achar = Array.from(sel.options).find((o) => o.value.trim().toLowerCase() === alvo)
      || Array.from(sel.options).find((o) => (o.text || '').trim().toLowerCase() === alvo);
    if (!achar) return;
    sel.value = achar.value;
    if (window.jQuery) window.jQuery(sel).val(achar.value).trigger('change');
    else sel.dispatchEvent(new Event('change', { bubbles: true }));
    const txt = (achar.text || '').trim();
    const span = Array.from(document.querySelectorAll('.jquery-selectbox-item, li, a')).find((s) => (s.textContent || '').trim() === txt);
    if (span && window.jQuery) window.jQuery(span).click();
  }, nome, String(valor));
}

/**
 * genericOnClick com waitForNavigation armado antes (senão o SIARE responde
 * "Ação inválida" telas adiante). Cai no envio manual do formTela se a função
 * da página quebrar (bug do próprio SIARE).
 */
export async function acao(page, { url, acaoSiare, valida = false, prova, tetoMs = 60000 }) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: tetoMs }).catch(() => null);
  await page.evaluate((u, a, v) => {
    const f = document.formTela || document.forms.formTela || document.forms[0];
    if (!f) return;
    try {
      if (typeof genericOnClick === 'function') { genericOnClick(f, v, u, a, '', true, true); return; }
    } catch { /* bug da página: envia na mão */ }
    let acaoEl = f.querySelector('[name="ACAO"]');
    if (!acaoEl) { acaoEl = document.createElement('input'); acaoEl.type = 'hidden'; acaoEl.name = 'ACAO'; f.appendChild(acaoEl); }
    acaoEl.value = a;
    f.action = u;
    f.submit();
  }, url, acaoSiare, valida).catch((e) => {
    // O envio começou antes do evaluate voltar: é a navegação que queríamos.
    if (!/context was destroyed|Cannot find context|detached/i.test(String(e && e.message))) throw e;
  });
  await nav;
  const erro = await lerErro(page);
  if (erro) throw new Error('O SIARE recusou: ' + erro);
  if (prova && !(await esperarCampo(page, prova))) throw new Error(await ondeParou(page));
}

/** Mensagem para quando a tela esperada não veio (a tela inicial = sequência recusada). */
export async function ondeParou(page) {
  const onde = await page.evaluate(() => location.pathname.split('/').slice(-2).join('/')).catch(() => '?');
  return /INICIAL_INTERNET/.test(onde)
    ? 'O SIARE voltou para a tela inicial no meio do caminho. Nada foi enviado.'
    : `A tela esperada não abriu (parou em ${onde}). Nada foi enviado.`;
}

/** Clica um botão pelo name/id (ex.: btnPesquisar) e espera a navegação. */
export async function clicarBotao(page, nome, { prova, tetoMs = 60000 } = {}) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: tetoMs }).catch(() => null);
  const clicou = await page.evaluate((n) => {
    const b = document.querySelector(`[name="${n}"]`) || document.getElementById(n);
    if (!b) return false;
    b.click();
    return true;
  }, nome);
  await nav;
  if (prova) await esperarCampo(page, prova);
  const erro = await lerErro(page);
  if (erro) throw new Error('O SIARE recusou: ' + erro);
  return clicou;
}

/**
 * <select> trocado por jquery.selectbox (Tipo de Circulação, Natureza, CFOP...).
 * Clica o item da lista como a pessoa faz; sem a lista, troca o valor e avisa
 * o change. Devolve o valor que ficou.
 */
export async function escolher(page, nome, valor) {
  if (valor == null || valor === '') return '';
  return page.evaluate((n, v) => {
    const sel = document.querySelector(`select[name="${n}"]`);
    if (!sel) return '';
    const caixa = sel.closest('.jquery-selectbox') || sel.parentElement;
    const item = caixa && caixa.querySelector(`.jquery-selectbox-item[rel="${v}"]`);
    if (item) {
      item.click();
      const lista = caixa.querySelector('.jquery-selectbox-list');
      if (lista) lista.style.display = 'none'; // a lista fica aberta depois do clique por script
    }
    if (sel.value !== v && Array.from(sel.options).some((o) => o.value === v)) {
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return sel.value;
  }, nome, String(valor));
}

/** Confere selects antes de enviar: devolve os nomes que não ficaram com o valor pedido. */
export async function selectsErrados(page, esperado) {
  return page.evaluate((m) => Object.entries(m)
    .filter(([n, v]) => v != null && v !== '' && (document.querySelector(`select[name="${n}"]`) || {}).value !== String(v))
    .map(([n]) => n), esperado);
}

/** CPF/CNPJ com a máscara do campo (a busca do SIARE só acha assim). */
export function cpfCnpjComMascara(s) {
  const d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/** Botão da tela atual pelo verbo (ex.: 'FINALIZAR'): URL e "valida" do próprio onclick. */
export async function botaoDaTela(page, verbo) {
  return page.evaluate((v) => {
    for (const a of document.querySelectorAll('a[onclick], img[onclick], input[onclick]')) {
      const m = (a.getAttribute('onclick') || '').match(/genericOnClick\([^,]+,\s*(true|false)\s*,\s*'([^']+)'\s*,\s*'([^']*)'/);
      if (m && m[3] === v) return { valida: m[1] === 'true', url: m[2] };
    }
    return null;
  }, verbo);
}

/** Aperta o botão da tela atual pelo verbo, com a URL que a própria tela usa. */
export async function acaoDoBotao(page, verbo, { urlPadrao, valida = true, ...resto } = {}) {
  const b = await botaoDaTela(page, verbo);
  if (!b && !urlPadrao) throw new Error(`A tela não tem o botão ${verbo}.`);
  const url = b ? (b.url.startsWith('http') ? b.url : BASE + b.url) : urlPadrao;
  await acao(page, { url, acaoSiare: verbo, valida: b ? b.valida : valida, ...resto });
}

/**
 * Lupa da linha de um campo (a busca do destinatário é CARREGAR; a do
 * remetente, PROCURAR). Devolve o verbo do onclick na mesma linha da tabela.
 */
export async function lupaDaLinha(page, campo) {
  return page.evaluate((c) => {
    const el = document.querySelector(`[name="${c}"]`);
    let tr = el && el.closest('tr');
    for (let i = 0; tr && i < 3; i++, tr = tr.parentElement && tr.parentElement.closest('tr')) {
      for (const a of tr.querySelectorAll('a[onclick]')) {
        const m = (a.getAttribute('onclick') || '').match(/genericOnClick\([^,]+,\s*(?:true|false)\s*,\s*'([^']+)'\s*,\s*'(PROCURAR|CARREGAR)'/);
        if (m) return { url: m[1], verbo: m[2] };
      }
    }
    return null;
  }, campo);
}

/**
 * GET/POST de apoio feito DENTRO da página (mesma sessão), para as janelinhas
 * do SIARE (CEP, município) sem abrir popup. Envia em ISO-8859-1, como o
 * navegador faz com os formulários do SIARE. Devolve o HTML.
 */
export async function buscarNaPagina(page, { abrir, enviar, campos }) {
  return page.evaluate(async (a, e, c) => {
    const dec = (b) => new TextDecoder('iso-8859-1').decode(b);
    const enc = (s) => Array.from(String(s)).map((ch) => {
      const n = ch.charCodeAt(0);
      if (/[A-Za-z0-9_.\-*]/.test(ch)) return ch;
      if (ch === ' ') return '+';
      return n < 256 ? '%' + n.toString(16).toUpperCase().padStart(2, '0') : encodeURIComponent(ch);
    }).join('');
    const g = await fetch(a, { credentials: 'include' });
    const html = dec(await g.arrayBuffer());
    if (!e) return html;
    // Reenvia o formulário da janelinha com os campos trocados (igual ao botão dela).
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const f = doc.forms.formTela || doc.forms[0];
    const m = new Map();
    for (const el of (f ? f.elements : [])) {
      if (!el.name || el.disabled || ['button', 'image', 'submit', 'file'].includes(el.type)) continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      if (!m.has(el.name)) m.set(el.name, []);
      m.get(el.name).push(el.value);
    }
    for (const [k, v] of Object.entries(c || {})) m.set(k, [v]);
    const corpo = Array.from(m).flatMap(([k, vs]) => vs.map((v) => enc(k) + '=' + enc(v))).join('&');
    const r = await fetch(e, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo });
    return dec(await r.arrayBuffer());
  }, abrir, enviar || '', campos || null);
}

/** Clica uma aba/link pelo texto exato (ex.: "Endereço/Contato"). */
export async function abrirAbaPorLink(page, texto, tetoMs = 30000) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: tetoMs }).catch(() => null);
  const clicou = await page.evaluate((t) => {
    const a = Array.from(document.querySelectorAll('a')).find((x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === t);
    if (!a) return false;
    a.click();
    return true;
  }, texto);
  if (clicou) await nav;
  return clicou;
}
