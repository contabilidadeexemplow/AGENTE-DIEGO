// Cordas das telas JSF/PrimeFaces do SIARE (mapeadas na tela logada em
// 15/10/2026, só leitura). Nessas telas o botão atualiza a página por AJAX:
// não há recarga, então espera-se a grade aparecer.
//   dte.procurador  /retaguardasef/.../procuradorDTEMnt.xhtml   form:cpfcnpj, form:dtInicio_input, form:dtFim_input → "Pesquisar"
//   epta.pesquisar  /sol/ctrl/SOL/FORM/CONSULTA_001 (contencioso) | CONSULTA_003 (não contencioso)
//                   rádio "Por Número de e-PTA" | "Por Identificação", campo do número → "Pesquisar"
// Campos e botões são achados pelo rótulo/texto, não pelos ids automáticos (j_idt…).
// TESTADAS NA TELA (15/10/2026): procuradores (pesquisa e "Nenhum resultado
// encontrado") e e-PTA por número (inputmask, "Nenhum registro encontrado.").
// O aviso amarelo (ui-messages-warn) do DT-e não é erro.
import { BASE, pedeLogin } from './navegador.mjs';
import { dormir } from './siare-dom.mjs';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

async function abrirJsf(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
  if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a tela.');
  const ok = await page.waitForSelector('form[id="form"], form', { timeout: 20000 }).catch(() => null);
  if (!ok) throw new Error('A tela não abriu como esperado.');
}

/** Digita como uma pessoa (as máscaras do PrimeFaces só aceitam teclado). */
async function digitar(page, seletor, valor) {
  if (valor == null || valor === '') return false;
  const el = await page.$(seletor);
  if (!el) return false;
  await el.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await el.type(String(valor), { delay: 20 });
  await page.evaluate((s) => { const e = document.querySelector(s); if (e) { e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); } }, seletor);
  return true;
}

async function clicarPorTexto(page, texto) {
  const ok = await page.evaluate((t) => {
    const b = [...document.querySelectorAll('button, input[type=submit], input[type=button], a')].find((x) => (x.value || x.textContent || '').replace(/\s+/g, ' ').trim() === t);
    if (!b) return false;
    b.click();
    return true;
  }, texto);
  if (!ok) throw new Error(`Não achei o botão "${texto}".`);
}

/** Espera o AJAX trazer a grade (linhas, "nenhum registro" ou mensagem de erro). */
async function esperarGrade(page, tetoMs = 20000) {
  const ate = Date.now() + tetoMs;
  await dormir(600);
  while (Date.now() < ate) {
    const r = await page.evaluate(() => {
      const vazio = document.querySelector('.ui-datatable-empty-message');
      const linhas = [...document.querySelectorAll('tbody[id$="_data"] tr')].filter((tr) => !tr.classList.contains('ui-datatable-empty-message'));
      const msg = [...document.querySelectorAll('.ui-messages-error, .ui-message-error, .ui-growl-message')].map((m) => m.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)[0] || '';
      return { vazio: !!vazio, n: linhas.length, msg };
    }).catch(() => ({ vazio: false, n: 0, msg: '' }));
    if (r.msg) return { erro: r.msg };
    if (r.vazio || r.n) return r;
    await dormir(500);
  }
  return { n: 0, vazio: false };
}

async function linhas(page, max = 20) {
  return page.evaluate((m) => [...document.querySelectorAll('tbody[id$="_data"] tr')]
    .filter((tr) => !tr.classList.contains('ui-datatable-empty-message'))
    .slice(0, m)
    .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ')), max).catch(() => []);
}

// ---------------- dte.procurador (leitura) ----------------
export async function procuradoresDte({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  etapa('Abrindo os procuradores do DT-e');
  await abrirJsf(page, BASE + '/retaguardasef/sistema/domicilioeletronico/procuradorDTEMnt.xhtml');
  if (e.cpfCnpj) await digitar(page, '[id="form:cpfcnpj"]', digitos(e.cpfCnpj));
  if (e.inicio) await digitar(page, '[id="form:dtInicio_input"]', e.inicio);
  if (e.fim) await digitar(page, '[id="form:dtFim_input"]', e.fim);
  etapa('Pesquisando');
  await clicarPorTexto(page, 'Pesquisar');
  const r = await esperarGrade(page);
  await evidencia('procuradores-dte');
  if (r.erro) throw new Error('O SIARE pediu: ' + r.erro);
  const itens = await linhas(page);
  return { mensagem: itens.length ? `${itens.length} procurador(es).` : 'Nenhum procurador cadastrado.', itens };
}

// ---------------- epta.pesquisar (leitura) ----------------
export async function pesquisarEpta({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  const tela = e.tipo === 'nao' ? 'CONSULTA_003' : 'CONSULTA_001'; // 003 = não contencioso
  etapa('Abrindo a pesquisa de e-PTA');
  await abrirJsf(page, BASE + '/sol/ctrl/SOL/FORM/' + tela + '?ACAO=VISUALIZAR');
  const porNumero = !!String(e.numero || '').trim();
  // Rádio pelo rótulo: "Por Número de e-PTA" ou "Por Identificação".
  await page.evaluate((num) => {
    const alvo = num ? /n[úu]mero/i : /identifica/i;
    const lab = [...document.querySelectorAll('label')].find((l) => alvo.test(l.textContent || ''));
    const r = lab && (document.getElementById(lab.getAttribute('for')) || lab.previousElementSibling);
    const caixa = r && (r.closest('.ui-radiobutton') || r.parentElement);
    (caixa && caixa.querySelector('.ui-radiobutton-box') ? caixa.querySelector('.ui-radiobutton-box') : r)?.click();
  }, porNumero).catch(() => undefined);
  await dormir(800);
  if (!porNumero) {
    // "Por Identificação" exige o Tipo de Identificação (lista do próprio SIARE).
    // Em 15/10/2026 a lista veio VAZIA para produtor PF: aí só dá por número.
    const tipos = await page.evaluate(() => {
      const sel = document.querySelector('[id^="form:idPesquisa:"] .ui-selectonemenu select');
      return sel ? Array.from(sel.options).filter((o) => o.value).map((o) => o.value) : [];
    }).catch(() => []);
    if (!tipos.length) throw new Error('Por identificação o SIARE não lista nada para este acesso. Informe o número do e-PTA.');
    await page.evaluate((v) => {
      const sel = document.querySelector('[id^="form:idPesquisa:"] .ui-selectonemenu select');
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, tipos[0]);
    await dormir(1200);
  }
  if (porNumero) {
    // O campo do número fica dentro do bloco de pesquisa (form:idPesquisa:…).
    const sel = await page.evaluate(() => {
      const i = [...document.querySelectorAll('[id^="form:idPesquisa:"] input[type="text"], input[id^="form:idPesquisa:"][type="text"]')][0];
      return i ? `[id="${i.id}"]` : '';
    });
    if (!sel || !(await digitar(page, sel, String(e.numero).trim()))) throw new Error('Não achei o campo do número do e-PTA.');
  }
  etapa('Pesquisando');
  await clicarPorTexto(page, 'Pesquisar');
  const r = await esperarGrade(page);
  await evidencia('epta');
  if (r.erro) throw new Error('O SIARE pediu: ' + r.erro);
  const itens = await linhas(page);
  return { mensagem: itens.length ? `${itens.length} processo(s).` : 'Nenhum processo encontrado.', itens };
}

// ---------------- pr.autorizarEmissor (cooperativa/sindicato que emite NFA-e) ----------------
// Produtor Rural → Autorizar Emissor de NFAe (lido em 15/10/2026): o lápis
// "Incluir/Excluir" abre uma lista dupla (PrimeFaces pickList, form:pickList):
// "Não Autorizados" → "Autorizados" com os botões Add/Remove; o envio é o
// botão form:confirmar (AJAX) e a resposta vem em form:pmessage.
const URL_EMISSOR = BASE + '/produtorruralsef/sistema/sol/selecaocooperativasindicato/selecaocooperativasindicatoemissor/selecaocoopsindemissornfa.xhtml';
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

export async function autorizarEmissor({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  const alvo = semAcento(e.entidade);
  const tirar = String(e.acao || 'incluir') === 'excluir';
  if (alvo.length < 3) throw new Error('Informe a cooperativa ou o sindicato.');
  etapa('Abrindo a autorização de emissor');
  await abrirJsf(page, URL_EMISSOR);
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button, a')).find((el) => /Incluir\/Excluir/i.test((el.textContent || '') + (el.title || '')));
    if (b) b.click();
  });
  if (!(await page.waitForSelector('.ui-picklist', { timeout: 30000 }).catch(() => null))) throw new Error('A lista de cooperativas e sindicatos não abriu.');
  await dormir(800);
  // Acha a entidade na lista certa: incluir procura nos "não autorizados"; excluir, nos autorizados.
  const lado = tirar ? '.ui-picklist-target' : '.ui-picklist-source';
  const achado = await page.evaluate((sel, a) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const itens = Array.from(document.querySelectorAll(sel + ' li.ui-picklist-item'));
    const iguais = itens.filter((li) => norm(li.getAttribute('data-item-label')) === a);
    const parecidos = iguais.length ? iguais : itens.filter((li) => norm(li.getAttribute('data-item-label')).includes(a));
    if (parecidos.length !== 1) return { n: parecidos.length, nomes: parecidos.slice(0, 5).map((li) => li.getAttribute('data-item-label')) };
    parecidos[0].click();
    return { n: 1, nome: parecidos[0].getAttribute('data-item-label') };
  }, lado, alvo);
  if (achado.n === 0) throw new Error(tirar ? 'Essa entidade não está entre as autorizadas.' : 'Essa entidade não está na lista do SIARE (ou já está autorizada).');
  if (achado.n > 1) throw new Error('Mais de uma entidade com esse nome: ' + achado.nomes.join('; ') + '. Escreva o nome completo.');
  await dormir(300);
  await page.evaluate((cls) => { const b = document.querySelector(cls); if (b) b.click(); }, tirar ? '.ui-picklist-button-remove' : '.ui-picklist-button-add');
  await dormir(800);
  const moveu = await page.evaluate((sel, nome) => Array.from(document.querySelectorAll(sel + ' li.ui-picklist-item')).some((li) => li.getAttribute('data-item-label') === nome), tirar ? '.ui-picklist-source' : '.ui-picklist-target', achado.nome);
  if (!moveu) throw new Error('A lista não aceitou a mudança.');
  await evidencia('emissor-preenchido');
  await pausar([[tirar ? 'Tirar a autorização de' : 'Autorizar a emitir NFA-e', achado.nome]]);
  etapa('Confirmando no SIARE');
  await page.evaluate(() => { const b = document.getElementById('form:confirmar'); if (b) b.click(); });
  let msg = '';
  for (const ate = Date.now() + 30000; Date.now() < ate && !msg; ) {
    await dormir(800);
    msg = await page.evaluate(() => ((document.getElementById('form:pmessage') || {}).innerText || '').replace(/\s+/g, ' ').trim()).catch(() => '');
  }
  await evidencia('emissor-resultado');
  if (!msg) {
    const erro = new Error('O SIARE não respondeu à confirmação. Confira em Autorizar Emissor antes de repetir.');
    erro.semProtocolo = true;
    throw erro;
  }
  if (/erro|inv[áa]lid|n[ãa]o foi poss/i.test(msg)) throw new Error('O SIARE recusou: ' + msg.slice(0, 200));
  const protocolo = (msg.match(/protocolo[:\s]*([\d.\-/]+)/i) || [])[1] || '';
  return { ...(protocolo ? { protocolo } : {}), confirmado: true, mensagem: msg.slice(0, 200) };
}
