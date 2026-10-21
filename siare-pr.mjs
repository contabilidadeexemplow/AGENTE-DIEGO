// Alteração cadastral da IE de Produtor Rural PF no SIARE-MG.
// Guiado por specs/pr.alteracao_cadastral.json. A página chega já logada.
//
// SEGURANÇA: para ANTES do FINALIZAR e chama `pausar(previa)`.
//
// CONFERIDO NA TELA REAL (15/10/2026, só leitura, sem Finalizar):
// - aba 1 Atividade Rural (SERVICO_006): dataNascimento, nief, optanteRegLeite,
//   temExploracaoSociedade; CNAE é só leitura (lupa);
// - aba 2 "Estabelecimento/Propriedade Rural" (SERVICO_008): nomeEstabelecimento,
//   tipoVinculo.id, dataValContrato, areaImovel, areaExploracao, nirf, nima;
// - aba 3 "Endereço/Contato" (SERVICO_009): enderecoEstabelecimento.refLocalizacao,
//   BUSCA (E=e-mail, C=carta), comunicacao.email, comunicacao.telefone;
//   o endereço em si é só leitura (janelinha) e fica fora do app;
// - as abas abrem por POST (genericOnClick valida=true) e cada aba tem o
//   próprio FINALIZAR (SERVICO_006/008/009): usa o botão da tela atual.
// - CNAE (lido em 15/10/2026): o botão chama buscaAtividade(1|2), que abre a janela
//   PRURAL/CNAE_SEL_PR; "Seleção rápida" (txtCodigoSelRapida) + selecionar() fecha
//   a janela e devolve código, identificador e descrição à tela (opener);
// - proprietários (aba 2, SERVICO_008): Novo (VALIDAR) → CADASTRO_029: tipo F/J +
//   identificação → Pesquisar (EXIBIRFLT traz nome e endereço) → Confirmar
//   (CONFNOVO) põe na grade do pedido. Tirar da grade pede confirmação: fica com a pessoa.
import { abrirAbaPorLink, acao, acaoDoBotao, dormir, escolher, esperarCampo, lerErro, radio, radioComRecarga, selecionar, SOL, texto } from './siare-dom.mjs';
import { pedeLogin, tratarDialogos } from './navegador.mjs';
import { linhaPeloCep } from './siare-nfa.mjs';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const virgula = (v) => String(v).replace('.', ',');

const URL_ABRIR = SOL + '/PRURAL/SERVICO_035?ACAO=VISUALIZAR&APLICACAO=SOL&MODULO=PRURAL&SIGLA=SERVICO_006&ACAO_TELA=VISUALIZAR';

// app (catálogo) → { aba, nome no SIARE, tipo, rótulo para o "vai mudar" }
const CAMPOS = [
  { app: 'dataNascimento', aba: 0, nome: 'dataNascimento', tipo: 'data', rotulo: 'Data de nascimento' },
  { app: 'nief', aba: 0, nome: 'nief', tipo: 'texto', rotulo: 'Nº no IEF' },
  { app: 'optanteLeite', aba: 0, nome: 'optanteRegLeite', tipo: 'radio', rotulo: 'Optante pelo Programa do Leite' },
  { app: 'sociedade', aba: 0, nome: 'temExploracaoSociedade', tipo: 'radio', rotulo: 'Explora em sociedade' },
  { app: 'nomeEstabelecimento', aba: 1, nome: 'nomeEstabelecimento', tipo: 'texto', rotulo: 'Nome do estabelecimento' },
  { app: 'vinculo', aba: 1, nome: 'tipoVinculo.id', tipo: 'select', rotulo: 'Vínculo com o imóvel' },
  { app: 'validadeContrato', aba: 1, nome: 'dataValContrato', tipo: 'data', rotulo: 'Validade do contrato' },
  { app: 'areaImovel', aba: 1, nome: 'areaImovel', tipo: 'decimal', rotulo: 'Área do imóvel (ha)' },
  { app: 'areaExploracao', aba: 1, nome: 'areaExploracao', tipo: 'decimal', rotulo: 'Área de exploração (ha)' },
  { app: 'cib', aba: 1, nome: 'nirf', tipo: 'texto', rotulo: 'Nº CIB (Receita)' },
  { app: 'ima', aba: 1, nome: 'nima', tipo: 'texto', rotulo: 'Nº IMA' },
  { app: 'referencia', aba: 2, nome: 'enderecoEstabelecimento.refLocalizacao', tipo: 'texto', rotulo: 'Referência de localização' },
  { app: 'correspondencia', aba: 2, nome: 'BUSCA', tipo: 'radio', rotulo: 'Recebimento de correspondência' },
  { app: 'email', aba: 2, nome: 'comunicacao.email', tipo: 'texto', rotulo: 'E-mail' },
  { app: 'telefone', aba: 2, nome: 'comunicacao.telefone', tipo: 'texto', rotulo: 'Telefone' },
];
const ABAS = ['Atividade Rural', 'Estabelecimento/Propriedade Rural', 'Endereço/Contato', 'Sociedade de Produtor Rural'];
const PROVA_ABA = ['[name="dataNascimento"], [name="optanteRegLeite"]', '[name="nomeEstabelecimento"], [name="tipoVinculo.id"]', '[name="comunicacao.email"], [name="BUSCA"]', '[name="tipoSociedade.id"]'];
// Abas 2 e 3 abrem por POST, como o link da própria tela (genericOnClick valida=true).
const URL_ABA = [null, SOL + '/PRURAL/SERVICO_006?ACAO=REDIRECION&COD_TELA=5', SOL + '/PRURAL/SERVICO_006?ACAO=REDIRECION&COD_TELA=6', SOL + '/PRURAL/SERVICO_006?ACAO=REDIRECION&COD_TELA=7'];

const CNAES = [
  { app: 'cnaePrincipal', qual: 1, campo: 'cnaePrincipal', rotulo: 'CNAE principal' },
  { app: 'cnaeSecundaria', qual: 2, campo: 'cnaeSecundaria', rotulo: 'CNAE secundária' },
];

/** CNAE de 7 dígitos no formato da tela ("0133402" → "0133-4/02"); outro tamanho → ''. */
export function codigoCnae(v) {
  const d = digitos(v);
  return d.length === 7 ? `${d.slice(0, 4)}-${d.slice(4, 5)}/${d.slice(5)}` : '';
}

/** O que vai mudar, só com o que a pessoa preencheu (puro, testável). */
export function mudancasDeCadastro(entradas) {
  const e = entradas || {};
  const mudancas = CAMPOS.filter((c) => e[c.app] != null && e[c.app] !== '').map((c) => ({ ...c, valor: e[c.app] }));
  const avisos = [];
  const cnaes = [];
  for (const c of CNAES) {
    if (e[c.app] == null || String(e[c.app]).trim() === '') continue;
    const codigo = codigoCnae(e[c.app]);
    if (codigo) cnaes.push({ ...c, codigo });
    else avisos.push(`${c.rotulo} "${e[c.app]}" não tem 7 dígitos: não alterado.`);
  }
  const proprietarios = [];
  for (const p of Array.isArray(e.proprietarios) ? e.proprietarios : []) {
    const doc = digitos(p && p.cpfCnpj);
    if (doc.length === 11 || doc.length === 14) proprietarios.push({ doc, nome: String(p.nome ?? '').trim() });
    else if (doc || (p && p.nome)) avisos.push(`Proprietário "${(p && p.nome) || doc}" sem CPF/CNPJ válido: não incluído.`);
  }
  // Sociedade (aba 4, só com "explorada em sociedade = Sim"): tipo e participantes.
  let sociedade = null;
  if (String(e.sociedade) === 'true' && (e.tipoSociedade || (Array.isArray(e.socios) && e.socios.length))) {
    const tipo = String(e.tipoSociedade ?? '');
    if (!TIPOS_SOCIEDADE[tipo]) avisos.push('Escolha o tipo de sociedade.');
    const socios = [];
    for (const s of Array.isArray(e.socios) ? e.socios : []) {
      const cpf = digitos(s && s.cpf);
      const pct = Number(String(s && s.participacao).replace(',', '.'));
      const nasc = String((s && s.dataNascimento) || '').trim();
      if (cpf.length !== 11 || !(pct > 0 && pct <= 100) || !/^\d{2}\/\d{2}\/\d{4}$/.test(nasc)) {
        avisos.push(`Participante ${cpf || '?'}: falta CPF, participação (%) ou nascimento: não incluído.`);
        continue;
      }
      socios.push({ cpf, participacao: String(pct).replace('.', ','), dataNascimento: nasc, tipoCoTitular: String((s && s.tipoCoTitular) || '') });
    }
    if (TIPOS_SOCIEDADE[tipo]) sociedade = { tipo, socios };
  } else if (String(e.sociedade) === 'true') {
    avisos.push('Com sociedade = Sim, o SIARE exige o tipo e os participantes.');
  }
  const previa = [
    ...mudancas.map((m) => [m.rotulo, m.tipo === 'radio' && (m.valor === 'true' || m.valor === 'false') ? (m.valor === 'true' ? 'Sim' : 'Não') : String(m.valor)]),
    ...cnaes.map((c) => [c.rotulo, c.codigo]),
    ...proprietarios.map((p) => ['Incluir proprietário', (p.nome ? p.nome + ' · ' : '') + p.doc]),
    ...(sociedade ? [['Tipo de sociedade', TIPOS_SOCIEDADE[sociedade.tipo]], ...sociedade.socios.map((s) => ['Incluir participante', `${s.cpf} · ${s.participacao}%`])] : []),
  ];
  return { mudancas, cnaes, proprietarios, sociedade, avisos, previa };
}

/** Tipos de sociedade da aba "Sociedade de Produtor Rural" (tipoSociedade.id, lidos em 15/10/2026). */
export const TIPOS_SOCIEDADE = { 6: 'Co-propriedade', 1: 'Co-usufruto', 5: 'Grupo familiar', 3: 'Meação', 4: 'Parceria', 2: 'Outro' };

/**
 * Participante da sociedade (aba 4, SERVICO_007): Novo (VALIDAR) → CADASTRO_028:
 * CPF → Pesquisar (o SIARE traz nome e endereço) → participação, nascimento e,
 * no grupo familiar, tipo de co-titular → Confirmar (CONFNOVO) põe na grade.
 * O produtor dono da IE entra sozinho: não se informa.
 */
async function incluirSocio(page, s) {
  await acao(page, { url: SOL + '/PRURAL/SERVICO_007', acaoSiare: 'VALIDAR', valida: true, prova: '[name="participante.identificacao"]' });
  await texto(page, 'participante.identificacao', s.cpf);
  await acao(page, { url: SOL + '/PRURAL/CADASTRO_028', acaoSiare: 'EXIBIRFLT', valida: false });
  if (!(await esperarCampo(page, '[name="participacao"]', 15000))) {
    const aviso = await page.evaluate(() => ((document.body && document.body.innerText) || '').split(/\r?\n/).map((x) => x.trim()).find((x) => /inserido automaticamente|n[ãa]o (foi )?encontrad|inv[áa]lid/i.test(x) && x.length < 200) || '').catch(() => '');
    await acao(page, { url: SOL + '/PRURAL/CADASTRO_028', acaoSiare: 'DESISTIR', prova: '[name="tipoSociedade.id"]' }).catch(() => undefined);
    throw new Error(`O SIARE não aceitou o participante ${s.cpf}${aviso ? ': ' + aviso : '.'}`);
  }
  await texto(page, 'participacao', s.participacao);
  await texto(page, 'dataNascimento', s.dataNascimento, true);
  if (s.tipoCoTitular) await escolher(page, 'tipoCoTitular.id', s.tipoCoTitular);
  await acao(page, { url: SOL + '/PRURAL/CADASTRO_028', acaoSiare: 'CONFNOVO', valida: true, prova: '[name="tipoSociedade.id"]' });
  if (!(await docsDaGrade(page)).some((d) => d.includes(s.cpf))) {
    const erro = await lerErro(page).catch(() => '');
    throw new Error(`O participante ${s.cpf} não entrou na grade${erro ? ': ' + erro : '.'}`);
  }
}

/**
 * CNAE pelo caminho da tela: botão → janela CNAE_SEL_PR → "Seleção rápida" →
 * selecionar() (a janela fecha e devolve o CNAE à tela). Confere o que ficou.
 */
async function escolherCnae(page, c) {
  const abriu = new Promise((ok) => page.once('popup', ok));
  await page.evaluate((n) => { setTimeout(() => window.buscaAtividade(n), 0); }, c.qual);
  const janela = await Promise.race([abriu, dormir(20000).then(() => null)]);
  if (!janela) throw new Error('A busca de CNAE do SIARE não abriu.');
  tratarDialogos(janela, () => undefined, () => false);
  try {
    await janela.waitForSelector('[name="txtCodigoSelRapida"]', { timeout: 20000 });
    await janela.evaluate((v) => { document.querySelector('[name="txtCodigoSelRapida"]').value = v; }, c.codigo);
    const fechou = new Promise((ok) => janela.once('close', () => ok(true)));
    await janela.evaluate(() => {
      const b = Array.from(document.querySelectorAll('[onclick]')).find((el) => /selecionar\(\)/.test(el.getAttribute('onclick')));
      setTimeout(() => b && b.click(), 0);
    });
    if (!(await Promise.race([fechou, dormir(20000).then(() => false)]))) {
      const msg = await janela.evaluate(() => ((document.body && document.body.innerText) || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /inválid|não (foi )?encontrad|inexist|selecione/i.test(s) && s.length < 160) || '').catch(() => '');
      throw new Error(`O SIARE não aceitou o ${c.rotulo} ${c.codigo}${msg ? ': ' + msg : '.'}`);
    }
  } finally {
    if (!janela.isClosed()) await janela.close().catch(() => undefined);
  }
  await dormir(800);
  const [cod, desc] = await page.evaluate((k) => [document.formTela.elements[k + '.codigoFormatado'].value, document.formTela.elements[k + '.descricao'].value], c.campo);
  if (digitos(cod) !== digitos(c.codigo)) throw new Error(`O ${c.rotulo} ${c.codigo} não ficou na tela (ficou ${cod || 'vazio'}).`);
  return desc;
}

const docsDaGrade = (page) => page.evaluate(() => Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((c) => ((c.closest('tr') || {}).textContent || '').replace(/\D/g, '')));

/**
 * Proprietário na grade da aba 2: Novo (VALIDAR) → CADASTRO_029 → tipo F/J +
 * identificação → Pesquisar (o SIARE traz o nome) → Confirmar (CONFNOVO), que põe
 * na grade do pedido (só vai à Fazenda no FINALIZAR). Devolve o nome do SIARE.
 */
async function incluirProprietario(page, p, grade = '/PRURAL/SERVICO_008', provaGrade = PROVA_ABA[1]) {
  await acao(page, { url: SOL + grade, acaoSiare: 'VALIDAR', valida: true, prova: '[name="identificacao.identificacao"]' });
  await page.evaluate((t) => { const r = document.querySelector(`[name="identificacao.tipoIdentificacao"][value="${t}"]`); if (r && !r.checked) r.click(); }, p.doc.length === 14 ? 'J' : 'F');
  await dormir(300);
  await texto(page, 'identificacao.identificacao', p.doc);
  await acao(page, { url: SOL + '/PRURAL/CADASTRO_029', acaoSiare: 'EXIBIRFLT', valida: true, prova: '[name="identificacao.identificacao"]' });
  const nome = await page.evaluate(() => {
    const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const tds = Array.from(document.querySelectorAll('td'));
    const i = tds.findIndex((td) => /^Nome \/ Nome Empresarial:?$/i.test(limpa(td.textContent)));
    if (i >= 0 && tds[i + 1]) return limpa(tds[i + 1].textContent);
    const m = limpa(document.body.innerText).match(/Nome \/ Nome Empresarial:\s*(.+?)\s+Endereço do Propriet/i);
    return m ? m[1] : '';
  });
  if (!nome) {
    const erro = await lerErro(page).catch(() => '');
    await acao(page, { url: SOL + '/PRURAL/CADASTRO_029', acaoSiare: 'DESISTIR', prova: provaGrade }).catch(() => undefined);
    throw new Error(`O SIARE não achou o proprietário ${p.doc}${erro ? ': ' + erro : '.'}`);
  }
  await acao(page, { url: SOL + '/PRURAL/CADASTRO_029', acaoSiare: 'CONFNOVO', valida: true, prova: provaGrade });
  if (!(await docsDaGrade(page)).some((d) => d.includes(p.doc))) {
    const erro = await lerErro(page).catch(() => '');
    throw new Error(`O proprietário ${p.doc} não entrou na grade${erro ? ': ' + erro : '.'}`);
  }
  return nome;
}

async function abrirAba(page, aba) {
  // Pelo link da aba (texto exato); sem ele, o mesmo POST que o link faz.
  if (!(await abrirAbaPorLink(page, ABAS[aba]))) await acao(page, { url: URL_ABA[aba], acaoSiare: 'null', valida: true });
  if (!(await esperarCampo(page, PROVA_ABA[aba], 20000))) throw new Error(`A aba "${ABAS[aba]}" não abriu.`);
}

export async function alterarCadastro({ page, entradas, etapa, evidencia, pausar }) {
  const { mudancas, cnaes, proprietarios, sociedade, avisos, previa } = mudancasDeCadastro(entradas);
  if (!mudancas.length && !cnaes.length && !proprietarios.length && !sociedade) throw new Error('Nada para alterar: nenhum campo foi preenchido.');

  etapa('Abrindo a alteração do cadastro');
  const abrirLimpa = async () => {
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }).catch(() => null);
    await page.goto(URL_ABRIR, { waitUntil: 'load', timeout: 90000 });
    await nav;
    if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a alteração.');
    if (!(await esperarCampo(page, PROVA_ABA[0], 30000))) throw new Error('A alteração do cadastro não abriu.');
  };
  await abrirLimpa();
  // O rascunho da alteração fica na sessão (um proprietário incluído e não enviado
  // continuou na grade ao reabrir, visto em 15/10/2026). DESISTIR da tela descarta o
  // rascunho sem gerar protocolo; depois abre de novo, limpa.
  await acao(page, { url: SOL + '/PRURAL/SERVICO_006', acaoSiare: 'DESISTIR', valida: false }).catch(() => undefined);
  await abrirLimpa();

  // Preenche aba por aba, na ordem das abas do SIARE.
  for (let aba = 0; aba < ABAS.length; aba++) {
    const daAba = mudancas.filter((m) => m.aba === aba);
    const extra = (aba === 0 && cnaes.length) || (aba === 1 && proprietarios.length) || (aba === 3 && sociedade);
    if (!daAba.length && !extra) continue;
    if (aba > 0) await abrirAba(page, aba);
    etapa('Preenchendo ' + ABAS[aba]);
    for (const m of daAba) {
      if (m.tipo === 'data') await texto(page, m.nome, m.valor, true);
      else if (m.tipo === 'decimal') await texto(page, m.nome, virgula(m.valor));
      else if (m.tipo === 'select') await selecionar(page, m.nome, m.valor);
      // Sociedade = Sim recarrega a tela e libera a aba Sociedade: espera a recarga.
      else if (m.tipo === 'radio' && m.app === 'sociedade') await radioComRecarga(page, m.nome, m.valor, PROVA_ABA[0]);
      else if (m.tipo === 'radio') await radio(page, m.nome, m.valor);
      else await texto(page, m.nome, m.app === 'telefone' ? digitos(m.valor) : m.valor);
    }
    if (aba === 0) {
      for (const c of cnaes) {
        etapa(c.rotulo + ' ' + c.codigo);
        const desc = await escolherCnae(page, c);
        const linha = previa.find(([k, v]) => k === c.rotulo && v === c.codigo);
        if (linha && desc) linha[1] = `${c.codigo} · ${desc}`;
      }
    }
    if (aba === 1 && proprietarios.length) {
      const naGrade = await docsDaGrade(page);
      for (const p of proprietarios) {
        const linha = previa.find(([k, v]) => k === 'Incluir proprietário' && v.endsWith(p.doc));
        if (naGrade.some((d) => d.includes(p.doc))) { if (linha) linha[1] += ' (já está na grade)'; continue; }
        etapa('Incluindo proprietário ' + p.doc);
        const nome = await incluirProprietario(page, p);
        if (linha) linha[1] = `${nome} · ${p.doc}`;
      }
    }
    if (aba === 3 && sociedade) {
      if ((await escolher(page, 'tipoSociedade.id', sociedade.tipo)) !== sociedade.tipo) throw new Error('O SIARE não aceitou o tipo de sociedade.');
      await dormir(800);
      const naGrade = await docsDaGrade(page);
      for (const s of sociedade.socios) {
        if (naGrade.some((d) => d.includes(s.cpf))) continue;
        etapa('Incluindo participante ' + s.cpf);
        await incluirSocio(page, s);
      }
    }
  }
  await evidencia('alteracao-preenchida');

  // PONTO SEM RETORNO: para e espera a confirmação. Mostra o que vai mudar e os avisos.
  const paraConferir = [...previa, ...avisos.map((a) => ['Atenção', a])];
  await pausar(paraConferir.length ? paraConferir : null);

  // FINALIZAR (só depois do /confirmar), pelo botão da aba em que a tela está.
  etapa('Enviando o pedido de alteração');
  await acaoDoBotao(page, 'FINALIZAR', { urlPadrao: SOL + '/PRURAL/SERVICO_006', valida: true, tetoMs: 90000 });
  await dormir(2500);

  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const protocolo = (txt.match(/[Pp]rotocolo[:\s]*([\d.\-/]+)/) || [])[1] || '';
  await evidencia('alteracao-resultado');
  if (!protocolo) {
    const erro = new Error('O SIARE não devolveu o protocolo. Confira em "Acompanhar pedidos" antes de repetir.');
    erro.semProtocolo = true;
    throw erro;
  }
  return { protocolo, mensagem: 'Pedido de alteração enviado.' + (avisos.length ? ' ' + avisos.join(' ') : '') };
}

// ---------------- pr.estabelecimento (nova propriedade) ----------------
// Produtor Rural → Solic. de Inscrição - Demais Estab. (lido em 15/10/2026):
// SERVICO_035 SIGLA=SERVICO_001 mostra CPF e IE do 1º estabelecimento; CONFIRMAR
// abre o assistente (rascunho) com as abas Atividade Rural (SERVICO_001/002),
// Estabelecimento/Propriedade (COD_TELA=1, grade de proprietários em SERVICO_004),
// Endereço/Contato (COD_TELA=2, endereço do estabelecimento pela janelinha do CEP
// com mudarValorEstabelecimento) e Sociedade. FINALIZAR envia o pedido.
const URL_NOVA = SOL + '/PRURAL/SERVICO_035?ACAO=VISUALIZAR&APLICACAO=SOL&MODULO=PRURAL&SIGLA=SERVICO_001&ACAO_TELA=VISUALIZAR&PRIM_EST=1&DES_TIPO_SERV=PR_TIPO_SERVICO_SOLICITACAO_CONCESSAO';
const PROVA_NOVA = ['[name="nief"], [name="inscricaoAnterior"]', '[name="nomeEstabelecimento"]', '[name="enderecoEstabelecimento.refLocalizacao"], [name="comunicacao.telefone"]'];

/** O que vai na nova propriedade (puro, testável). */
export function camposNovaPropriedade(entradas) {
  const e = entradas || {};
  const faltam = [];
  if (!String(e.nomeEstabelecimento || '').trim()) faltam.push('nome da propriedade');
  // O SIARE não deixa sair da aba Atividade sem o CNAE principal ("Campo CNAE Principal Obrigatório").
  if (digitos(e.cnaePrincipal).length !== 7) faltam.push('CNAE principal (7 dígitos)');
  if (!e.vinculo) faltam.push('vínculo com o imóvel');
  if (!(Number(String(e.areaImovel ?? '').replace(',', '.')) > 0)) faltam.push('área do imóvel');
  if (!(Number(String(e.areaExploracao ?? '').replace(',', '.')) > 0)) faltam.push('área explorada');
  if (digitos(e.cep).length !== 8) faltam.push('CEP');
  if (!String(e.logradouro || '').trim() || !String(e.bairro || '').trim()) faltam.push('endereço e bairro');
  const estab = [
    ['nomeEstabelecimento', String(e.nomeEstabelecimento || '').trim().slice(0, 120), 'texto'],
    ['tipoVinculo.id', String(e.vinculo || ''), 'lista'],
    ['dataValContrato', e.validadeContrato || '', 'data'],
    ['areaImovel', e.areaImovel != null && e.areaImovel !== '' ? virgula(e.areaImovel) : '', 'texto'],
    ['areaExploracao', e.areaExploracao != null && e.areaExploracao !== '' ? virgula(e.areaExploracao) : '', 'texto'],
    ['nirf', digitos(e.cib), 'texto'],
    ['nima', digitos(e.ima), 'texto'],
  ].filter(([, v]) => v !== '');
  const contato = [
    ['enderecoEstabelecimento.refLocalizacao', String(e.referencia || '').trim(), 'texto'],
    ['comunicacao.email', String(e.email || '').trim(), 'texto'],
    ['comunicacao.telefone', digitos(e.telefone), 'texto'],
  ].filter(([, v]) => v !== '');
  const previa = [
    ['Propriedade', String(e.nomeEstabelecimento || '').trim()],
    ['Endereço', [e.logradouro, e.numero, e.bairro, digitos(e.cep)].filter(Boolean).join(', ')],
    ['Área total / explorada (ha)', `${e.areaImovel ?? ''} / ${e.areaExploracao ?? ''}`],
  ];
  return { faltam, estab, contato, declEstoque: e.declaracaoEstoque === true || e.declaracaoEstoque === 'true', previa };
}

async function irAbaNova(page, n) {
  const alvo = await page.evaluate((k) => {
    const marca = 'COD_TELA=' + k + "'";
    const s = Array.from(document.querySelectorAll('[onclick]')).map((el) => el.getAttribute('onclick')).find((x) => x.includes(marca)) || '';
    const m = s.match(/'(\/sol\/ctrl\/SOL\/[^']+)','([^']*)'/);
    return m ? { url: m[1], verbo: m[2] || 'null' } : null;
  }, n);
  if (!alvo) throw new Error('A aba da nova propriedade não abriu.');
  await acao(page, { url: 'https://www2.fazenda.mg.gov.br' + alvo.url, acaoSiare: alvo.verbo, valida: true, prova: PROVA_NOVA[n] });
}

export async function novaPropriedade({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  const c = camposNovaPropriedade(e);
  if (c.faltam.length) throw new Error('Falta: ' + c.faltam.join(', ') + '.');
  const { cnaes, proprietarios } = mudancasDeCadastro({ cnaePrincipal: e.cnaePrincipal, cnaeSecundaria: e.cnaeSecundaria, proprietarios: e.proprietarios });
  const abrirAssistente = async () => {
    await page.goto(URL_NOVA, { waitUntil: 'load', timeout: 90000 });
    if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a nova propriedade.');
    await acao(page, { url: SOL + '/PRURAL/SERVICO_001', acaoSiare: 'CONFIRMAR', valida: true, prova: PROVA_NOVA[0] });
  };
  etapa('Abrindo a inscrição da nova propriedade');
  await abrirAssistente();
  // O rascunho fica na sessão (como na alteração): DESISTIR (sem protocolo) e abre limpo.
  const desistir = await page.evaluate(() => ((Array.from(document.querySelectorAll('[onclick]')).map((el) => el.getAttribute('onclick')).find((s) => s.includes("'DESISTIR'")) || '').match(/'(\/sol\/ctrl\/SOL\/[^']+)','DESISTIR'/) || [])[1] || '');
  if (desistir) { await acao(page, { url: 'https://www2.fazenda.mg.gov.br' + desistir, acaoSiare: 'DESISTIR', valida: false }).catch(() => undefined); await abrirAssistente(); }

  etapa('Atividade rural');
  if (e.nief) await texto(page, 'nief', digitos(e.nief));
  for (const cn of cnaes) await escolherCnae(page, cn);

  etapa('Estabelecimento/propriedade');
  await irAbaNova(page, 1);
  for (const [n, v, t] of c.estab) {
    if (t === 'lista') { if ((await escolher(page, n, v)) !== v) throw new Error('O SIARE não aceitou o vínculo com o imóvel.'); }
    else await texto(page, n, v, t === 'data');
  }
  await radio(page, 'temDeclEstoque', c.declEstoque ? 'true' : 'false');
  for (const p of proprietarios) await incluirProprietario(page, p, '/PRURAL/SERVICO_004', PROVA_NOVA[1]);

  etapa('Endereço e contato');
  await irAbaNova(page, 2);
  const linha = await linhaPeloCep(page, e, `${SOL}/RETAGUAR/ENDERECO_INTERNET_PSQ?funcaoRetorno=opener.mudarValorEstabelecimento&getDadosEnd=opener.getDadosEndEstabelecimento&ACAO=VISUALIZAR`, 'a propriedade');
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => null);
  const chamou = await page.evaluate((l) => { if (typeof window.mudarValorEstabelecimento !== 'function') return false; setTimeout(() => window.mudarValorEstabelecimento(l), 0); return true; }, linha);
  if (!chamou) throw new Error('Não consegui pôr o endereço da propriedade.');
  await nav;
  if (!(await esperarCampo(page, PROVA_NOVA[2], 30000))) throw new Error('A aba de endereço não voltou depois do endereço.');
  const gravou = await page.evaluate(() => Number((document.querySelector('[name="enderecoEstabelecimento.idMunicipio"]') || {}).value || 0) > 0).catch(() => false);
  if (!gravou) throw new Error('O SIARE não guardou o endereço da propriedade.');
  for (const [n, v] of c.contato) await texto(page, n, v);
  if (e.correspondencia) await radio(page, 'BUSCA', String(e.correspondencia));
  await evidencia('nova-propriedade-preenchida');

  await pausar([...c.previa, ...cnaes.map((x) => [x.rotulo, x.codigo]), ...proprietarios.map((p) => ['Proprietário', p.doc])]);
  etapa('Enviando o pedido de inscrição');
  await acaoDoBotao(page, 'FINALIZAR', { urlPadrao: SOL + '/PRURAL/SERVICO_005', valida: true, tetoMs: 90000 });
  await dormir(2500);
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const protocolo = (txt.match(/[Pp]rotocolo[:\s]*([\d.\-/]+)/) || [])[1] || '';
  await evidencia('nova-propriedade-resultado');
  if (!protocolo) {
    const erro = new Error('O SIARE não devolveu o protocolo. Confira em "Acompanhar pedidos" antes de repetir.');
    erro.semProtocolo = true;
    throw erro;
  }
  return { protocolo, mensagem: 'Pedido de inscrição da nova propriedade enviado.' };
}
