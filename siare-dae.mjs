// Consultas de DAE (Documento de Arrecadação). App PÚBLICO (/arrecadacao/),
// SEM login do SIARE: cada corda marca `.semLogin = true`.
//
// Nomes dos campos CONFERIDOS na tela pública em 14/10/2026 (SIARE no ar):
//   consultar : txtNumeroDAE, cmbInputTipoIdentificacao, txtInputIdentificacao, cmbOrgaoPublico, btnPesquisar
//   comprovante: idem + txtInputIdentificacaoPix, btnEmitirComprovante
//   reemitir  : txtNumeroDAE, cmbOrgao, btnPagarViaInternet
// Falta só confirmar o retorno (grade/PDF) numa consulta real. Todas só LEEM.
import { acao, dormir, escolher, esperarCampo, selecionar, SOL, texto } from './siare-dom.mjs';
import { BASE, baixarPdf } from './navegador.mjs';

const ARREC = BASE + '/arrecadacao/ctrl/ARRECADA/ARRECADA';
const digitos = (s) => String(s ?? '').replace(/\D/g, '');

async function abrirPublico(page, url, prova) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }).catch(() => null);
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await nav;
  const manut = await page.evaluate(() => /ESTAMOS EM MANUTEN/i.test((document.body && document.body.innerText) || '')).catch(() => false);
  if (manut) throw new Error('O SIARE está em manutenção. Tente mais tarde.');
  if (prova && !(await esperarCampo(page, prova, 20000))) throw new Error('A tela do DAE não abriu como esperado.');
}

// ---------------- dae.consultar: ver se um DAE foi pago ----------------
export async function consultarDae({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  if (!e.numeroDAE) throw new Error('Informe o número do DAE.');
  etapa('Abrindo a consulta de pagamento');
  await abrirPublico(page, ARREC + '/CONSULTAR_PAGAMENTO_DAE?ACAO=VISUALIZAR', '[name="txtNumeroDAE"]');
  await texto(page, 'txtNumeroDAE', digitos(e.numeroDAE));
  if (e.tipoIdentificacao) await selecionar(page, 'cmbInputTipoIdentificacao', String(e.tipoIdentificacao));
  if (e.identificacao) await texto(page, 'txtInputIdentificacao', digitos(e.identificacao));
  await selecionar(page, 'cmbOrgaoPublico', String(e.orgao || '119')); // 119 = Secretaria de Estado de Fazenda
  etapa('Consultando');
  await acao(page, { url: ARREC + '/CONSULTAR_PAGAMENTO_DAE', acaoSiare: 'EXIBIRFLT' });
  await dormir(1200);
  await evidencia('dae-consulta');
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  // Mensagem de validação da própria tela (ex.: "Tamanho do número do DAE inválido").
  const aviso = (txt.match(/(Tamanho do número[^.]*\.|Informe o número[^.]*\.|Selecione[^.]*[ÓO]rg[ãa]o[^.]*\.?|[^.\n]*inv[áa]lid[oa][^.\n]*\.)/i) || [])[0];
  if (aviso) throw new Error('O SIARE pediu: ' + aviso.replace(/\s+/g, ' ').trim());
  const semReg = /nenhum registro|0 registro|não encontrad|inexistente|não localizad/i.test(txt);
  const pago = /pago|quitad|baixad/i.test(txt);
  return {
    mensagem: semReg ? 'DAE não encontrado.' : pago ? 'DAE pago.' : 'DAE encontrado (confira a situação na evidência).',
    itens: (txt.match(/(Situa[çc][ãa]o|Valor|Vencimento|Data de Pagamento)[:\s][^\n]{0,40}/gi) || []).slice(0, 8).map((s) => s.replace(/\s+/g, ' ').trim()),
  };
}
consultarDae.semLogin = true;

// ---------------- dae.comprovante: comprovante de pagamento ----------------
export async function comprovanteDae({ page, entradas, etapa, evidencia, guardarArquivo }) {
  const e = entradas || {};
  if (!e.identificacao && !e.numeroDAE) throw new Error('Informe a identificação ou o número do DAE.');
  etapa('Abrindo o comprovante de pagamento');
  await abrirPublico(page, ARREC + '/EMITIR_COMPROVANTE_PAGTO_DAE?ACAO=VISUALIZAR', '[name="txtInputIdentificacao"], [name="txtNumeroDAE"]');
  if (e.tipoIdentificacao) await selecionar(page, 'cmbInputTipoIdentificacao', String(e.tipoIdentificacao));
  // Tipo 4 = ID PIX (campo próprio); os demais vão no campo normal.
  if (String(e.tipoIdentificacao) === '4') await texto(page, 'txtInputIdentificacaoPix', e.identificacao);
  else if (e.identificacao) await texto(page, 'txtInputIdentificacao', digitos(e.identificacao)); // CPF/CNPJ/IE só com dígitos
  if (e.numeroDAE) await texto(page, 'txtNumeroDAE', digitos(e.numeroDAE));
  await selecionar(page, 'cmbOrgaoPublico', String(e.orgao || '119'));
  etapa('Gerando o comprovante');
  await acao(page, { url: ARREC + '/EMITIR_COMPROVANTE_PAGTO_DAE', acaoSiare: 'EMITIRCOMP' });
  await dormir(1500);
  await evidencia('dae-comprovante');
  const { pdf } = await baixarPdf(page, page.url());
  if (!pdf) throw new Error('Não consegui gerar o comprovante. Confira os dados e tente de novo.');
  const url = await guardarArquivo('comprovante-dae.pdf', pdf);
  return { mensagem: 'Comprovante gerado.', pdfs: [{ nome: 'Comprovante de pagamento', url }] };
}
comprovanteDae.semLogin = true;

// ---------------- dae.reemitir: gerar de novo um DAE ----------------
export async function reemitirDae({ page, entradas, etapa, evidencia, guardarArquivo }) {
  const e = entradas || {};
  if (!e.numeroDAE) throw new Error('Informe o número do DAE.');
  etapa('Abrindo a reemissão do DAE');
  await abrirPublico(page, ARREC + '/REEMITIR_DAE?ACAO=VISUALIZAR', '[name="txtNumeroDAE"]');
  await texto(page, 'txtNumeroDAE', digitos(e.numeroDAE));
  await selecionar(page, 'cmbOrgao', String(e.orgao || '119'));
  etapa('Gerando o documento');
  await acao(page, { url: ARREC + '/REEMITIR_DAE', acaoSiare: 'PAGAVIANET' });
  await dormir(1500);
  await evidencia('dae-reemissao');
  const { pdf } = await baixarPdf(page, page.url());
  if (!pdf) throw new Error('Não consegui gerar o DAE. Confira o número e tente de novo.');
  const url = await guardarArquivo('dae.pdf', pdf);
  return { mensagem: 'DAE gerado de novo.', pdfs: [{ nome: 'DAE', url }] };
}
reemitirDae.semLogin = true;

// ---------------- doc.certificar: autenticar documento (público, só leitura) ----------------
// Mapeado ao vivo 15/10/2026: /sol/ctrl/SOL/RETAGUAR/CERTIFICAR_DOCUMENTO, campos numero e dv.
export async function certificarDocumento({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  if (!e.numero || !e.digito) throw new Error('Informe o número e o dígito do documento.');
  etapa('Abrindo a certificação');
  await abrirPublico(page, SOL + '/RETAGUAR/CERTIFICAR_DOCUMENTO?ACAO=VISUALIZAR', '[name="numero"]');
  await texto(page, 'numero', digitos(e.numero));
  await texto(page, 'dv', digitos(e.digito));
  etapa('Certificando');
  await acao(page, { url: SOL + '/RETAGUAR/CERTIFICAR_DOCUMENTO', acaoSiare: 'EXIBIRFLT' });
  await dormir(1000);
  await evidencia('certificacao');
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const aviso = (txt.match(/([^.\n]*(inv[áa]lid[oa]|n[ãa]o (foi )?(localizad|encontrad))[^.\n]*\.?|Informe[^.\n]*\.)/i) || [])[0];
  if (aviso) return { mensagem: aviso.replace(/\s+/g, ' ').trim() };
  const autentico = /aut[êe]ntic|v[áa]lid|confere|emitido/i.test(txt);
  return { mensagem: autentico ? 'Documento autêntico.' : 'Consulta feita (confira o resultado na evidência).' };
}
certificarDocumento.semLogin = true;

// ---------------- dae.emitir: emitir DAE avulso (público) ----------------
// Mapeado AO VIVO em 15/10/2026 (dados fictícios, sem gerar DAE):
//   1º passo DOCUMENTO_ARRECADACAO: um combo por grupo (cmbICMS, cmbTaxas, cmbITCD,
//      cmbOutrasReceitas) → CONFIRMAR (só passa de tela).
//   2º passo (DAE_ICMS, TAXA_*, ITCD, OUTRAS_RECEITAS): cmbTipoIdentificacao,
//      txtIdentificacao → Pesquisar (EXIBIRFLT: traz nome, UF e município pela IE);
//      cmbUF (código; MG=14) → município por AJAX; cmbReceita (ICMS) / cmbReceitaSelecionada
//      (outras) / cmbServico + txtProtocolo (expediente) / cmbTrimestre, cmbExercicio
//      (TFAMG/TFDR); dtVencimento, dtPagamento, cmbPeriodo (1 Mensal, 2-3 quinzenas,
//      4-6 decêndios), cmbMes, cmbAno, txtReceita, txtMulta, txtJuros, txtInformacoes.
//   "Calcular multa e juros" (CALCULAR) só existe para débito vencido.
//   PONTO SEM RETORNO: "Gerar Pagamento" (btnPagarViaInternet → PAGAVIANET).
//   "DAE único" (INCLUIR) junta vários: não usado aqui.
const COMBO_DO_GRUPO = { ICMS: 'cmbICMS', Taxas: 'cmbTaxas', ITCD: 'cmbITCD', Outras: 'cmbOutrasReceitas' };
const PERIODO = { M: '1', Q1: '2', Q2: '3', D1: '4', D2: '5', D3: '6' };
const dinheiro = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.') || 0)).toFixed(2).replace('.', ',');

/** "10/2026" | "2026-10" → { mes: '10', ano: '2026' } (puro, testável). */
export function mesEAno(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/^(\d{1,2})\s*[/\-.]\s*(\d{4})$/) || t.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})$/);
  if (!m) return { mes: '', ano: '' };
  const [a, b] = m[1].length === 4 ? [m[2], m[1]] : [m[1], m[2]];
  return { mes: String(Number(a)), ano: b };
}

/** Campos do 2º passo a partir das entradas do app (puro, testável). */
export function camposDoDae(e) {
  const { mes, ano } = mesEAno(e.mesReferencia);
  const c = {};
  if (e.vencimento) c.dtVencimento = e.vencimento;
  if (e.pagamento) c.dtPagamento = e.pagamento;
  if (e.periodo) c.cmbPeriodo = PERIODO[e.periodo] || String(e.periodo);
  if (mes) { c.cmbMes = mes; c.cmbAno = ano; }
  if (e.valorReceita != null && e.valorReceita !== '') c.txtReceita = dinheiro(e.valorReceita);
  if (e.valorMulta != null && e.valorMulta !== '') c.txtMulta = dinheiro(e.valorMulta);
  if (e.valorJuros != null && e.valorJuros !== '') c.txtJuros = dinheiro(e.valorJuros);
  if (e.trimestre) c.cmbTrimestre = String(e.trimestre);
  if (e.exercicio) c.cmbExercicio = String(e.exercicio);
  if (e.protocolo) c.txtProtocolo = digitos(e.protocolo);
  if (e.informacoes) c.txtInformacoes = String(e.informacoes).slice(0, 400);
  return c;
}

/** Vencido? (pagamento depois do vencimento; datas dd/mm/aaaa) */
export function vencido(venc, pag) {
  const n = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? Number(m[3] + m[2] + m[1]) : 0; };
  return !!(n(venc) && n(pag) && n(pag) > n(venc));
}

/**
 * Valor (código) da opção de uma lista. modo: 'texto' (igual), 'nome' (igual sem
 * acento), 'receita' (código "0326-9"/"326" no começo do texto ou no value),
 * 'contem' (value igual ou texto contém).
 */
async function valorDaLista(page, nome, modo, alvo) {
  return page.evaluate((n, m, a) => {
    const s = document.querySelector(`select[name="${n}"]`);
    if (!s) return '';
    const sem = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    const dig = (x) => String(x || '').replace(/\D/g, '');
    const casa = {
      texto: (o) => o.text.trim() === a,
      nome: (o) => sem(o.text) === sem(a),
      receita: (o) => !!o.value && (o.value === String(Number(dig(a))) || dig(o.text).startsWith(dig(a).padStart(5, '0')) || dig(o.text).startsWith(dig(a).padStart(4, '0'))),
      contem: (o) => !!o.value && (o.value === a || o.text.toLowerCase().includes(String(a).toLowerCase())),
    }[m];
    const o = Array.from(s.options).find(casa);
    return o ? o.value : '';
  }, nome, modo, String(alvo));
}

/** Roda uma validação da própria tela (que avisa por alert) e devolve { ok, avisos }. */
async function validarNaTela(page, funcoes) {
  return page.evaluate((fs) => {
    window.__avisos = [];
    window.alert = (m) => window.__avisos.push(String(m));
    try {
      const ok = fs.every((f) => typeof window[f] !== 'function' || window[f]() !== false);
      return { ok, avisos: window.__avisos.join(' ') };
    } catch { return { ok: true, avisos: '' }; } // a validação do SIARE quebrou: segue
  }, funcoes);
}

export async function emitirDae({ page, entradas, etapa, evidencia, guardarArquivo, pausar }) {
  const e = entradas || {};
  const combo = COMBO_DO_GRUPO[e.grupoReceita];
  if (!combo || !e.receita) throw new Error('Escolha o tipo de receita do DAE.');
  if (String(e.receita) === '99') throw new Error('Emolumentos (Lei 25.126/24) ainda não são emitidos por aqui.');
  if (!e.identificacao) throw new Error('Informe o CPF, CNPJ ou IE de quem paga.');

  // 1º passo: o tipo de receita → CONFIRMAR (só passa de tela).
  etapa('Abrindo a emissão de DAE');
  await abrirPublico(page, ARREC + '/DOCUMENTO_ARRECADACAO?ACAO=VISUALIZAR', `[name="${combo}"]`);
  await escolher(page, combo, String(e.receita));
  await acao(page, { url: ARREC + '/DOCUMENTO_ARRECADACAO?ACAO=CONFIRMAR', acaoSiare: 'CONFIRMAR', prova: '[name="txtIdentificacao"]' });

  // 2º passo: quem paga → Pesquisar (traz nome, UF e município).
  etapa('Quem paga');
  if (e.tipoIdentificacao) await escolher(page, 'cmbTipoIdentificacao', String(e.tipoIdentificacao));
  await texto(page, 'txtIdentificacao', digitos(e.identificacao));
  let v = await validarNaTela(page, ['validarCampoObrigatorioAcaoPesquisar']);
  if (!v.ok) throw new Error('O SIARE pediu: ' + (v.avisos || 'confira a identificação'));
  await acao(page, { url: '', acaoSiare: 'EXIBIRFLT', prova: '[name="txtIdentificacao"]' });
  await dormir(800);

  // UF e município: se a pesquisa não trouxe, pelo que veio do app (UF é código: MG=14).
  const uf = String(e.uf || '').toUpperCase();
  if (uf) {
    const cod = await valorDaLista(page, 'cmbUF', 'texto', uf);
    const atual = await page.evaluate(() => (document.querySelector('select[name="cmbUF"]') || {}).value || '');
    if (cod && cod !== atual) { await escolher(page, 'cmbUF', cod); await dormir(2500); } // municípios vêm por AJAX
  }
  if (e.municipio) {
    const atual = await page.evaluate(() => (document.querySelector('select[name="cmbMunicipio"]') || {}).value || '');
    if (!atual) {
      const cod = await valorDaLista(page, 'cmbMunicipio', 'nome', e.municipio);
      if (cod) await escolher(page, 'cmbMunicipio', cod);
    }
  }

  // Receita específica (código "0326-9" ou "326") e serviço da taxa de expediente.
  if (e.codigoReceita) {
    const d = digitos(e.codigoReceita);
    const nome = (await page.$('select[name="cmbReceita"]')) ? 'cmbReceita' : (await page.$('select[name="cmbReceitaSelecionada"]')) ? 'cmbReceitaSelecionada' : '';
    if (nome) {
      const cod = await valorDaLista(page, nome, 'receita', d);
      if (!cod) throw new Error(`A receita ${e.codigoReceita} não está na lista do SIARE para este tipo.`);
      await escolher(page, nome, cod);
      await dormir(1500); // a receita decide por AJAX se há multa e juros
    }
  }
  if (e.servicoExpediente) {
    const cod = await valorDaLista(page, 'cmbServico', 'contem', e.servicoExpediente);
    if (!cod) throw new Error(`O serviço "${e.servicoExpediente}" não está na lista do SIARE.`);
    await escolher(page, 'cmbServico', cod);
  }
  if (e.documentoOrigem) await texto(page, 'txtNumeroDocumento', String(e.documentoOrigem).replace(/\s/g, ''));

  // Datas, período e valores: preenche só o que a tela tem.
  etapa('Valores do DAE');
  for (const [n, val] of Object.entries(camposDoDae(e))) {
    if (n.startsWith('cmb')) await escolher(page, n, val);
    else await texto(page, n, val, n.startsWith('dt'));
  }
  // Vencido e sem multa/juros informados: o próprio SIARE calcula.
  if (vencido(e.vencimento, e.pagamento) && !e.valorMulta && !e.valorJuros && (await page.$('img[name="btnCalcular"]'))) {
    etapa('Calculando multa e juros');
    v = await validarNaTela(page, ['validarCampoObrigatorioAcaoCalcular']);
    if (!v.ok) throw new Error('O SIARE pediu: ' + (v.avisos || 'confira os campos'));
    await acao(page, { url: '', acaoSiare: 'CALCULAR', prova: '[name="txtIdentificacao"]' });
  }

  // A mesma validação do botão "Gerar Pagamento", ANTES de parar para a confirmação.
  v = await validarNaTela(page, ['validarNome', 'validarCampoObrigatorioAcaoPagarViaInternet']);
  if (!v.ok) throw new Error('O SIARE pediu: ' + (v.avisos || 'confira os campos'));
  await evidencia('dae-preenchido');

  const previa = await page.evaluate(() => {
    const val = (n) => ((document.querySelector(`[name="${n}"]`) || {}).value || '').trim();
    const sel = (n) => { const s = document.querySelector(`select[name="${n}"]`); return s && s.value ? (s.options[s.selectedIndex].text || '').trim() : ''; };
    return [['Quem paga', val('txtNome')], ['Receita', sel('cmbReceita') || sel('cmbReceitaSelecionada') || sel('cmbServico')], ['Vencimento', val('dtVencimento')], ['Valor', val('txtReceita')], ['Multa', val('txtMulta')], ['Juros', val('txtJuros')]].filter(([, x]) => x);
  });

  // PONTO SEM RETORNO: o "Gerar Pagamento" cria o DAE.
  await pausar(previa);

  etapa('Gerando o DAE');
  await acao(page, { url: '', acaoSiare: 'PAGAVIANET', tetoMs: 90000 });
  await dormir(2000);
  await evidencia('dae-gerado');
  const fim = await page.evaluate(() => ({ tipo: document.contentType, url: location.href, texto: (document.body && document.body.innerText) || '' })).catch(() => ({ tipo: '', url: '', texto: '' }));
  const numero = (fim.texto.match(/(?:N[úu]mero\s*(?:do\s*)?DAE|DAE\s*n[ºo°]?)[:\s]*([\d.\-]{8,})/i) || [])[1] || '';
  const pdfs = [];
  if (/pdf/i.test(fim.tipo)) {
    const { pdf } = await baixarPdf(page, fim.url).catch(() => ({}));
    if (pdf) pdfs.push({ nome: 'DAE', url: await guardarArquivo('dae.pdf', pdf) });
  }
  // Sem número nem PDF: o DAE pode ter saído; o pedido fica "conferir" (nunca repete sozinho).
  return {
    ...(numero ? { numero: numero.replace(/\D/g, '') } : {}),
    mensagem: numero ? `DAE ${numero} gerado.` : pdfs.length ? 'DAE gerado.' : 'Pedido de DAE enviado. Confira em "Consultar DAE".',
    ...(pdfs.length ? { pdfs, confirmado: true } : {}),
  };
}
emitirDae.semLogin = true;
