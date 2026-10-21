// Emissão de Nota Fiscal Avulsa (NFA-e), perfil Produtor Rural PF, no SIARE-MG.
//
// Portado do robô que já emite em produção (PONTE/robo-campo) e do MAGNU, guiado
// pelo mapa em specs/nfa.emissao_especial.json e GUIA-SIARE.md. A página chega
// JÁ logada (o login é feito antes, em navegador.mjs).
//
// SEGURANÇA
// - Para ANTES do FINALIZAR e chama `pausar(previa)`: só segue com a confirmação
//   da pessoa (POST /confirmar).
// - Sem protocolo no fim, NUNCA reenvia: a nota pode ter saído.
// - Prova cada tela por um campo que só existe nela, não pelo título.
//
// CONFERIDO NA TELA REAL (15/10/2026, sem Finalizar e sem confirmar item):
// - Tipo de Circulação, Natureza, Finalidade e CFOP são jquery.selectbox; o
//   clique em outros rádios pode zerar a Natureza → escolhe e CONFERE antes de enviar;
// - a lupa do destinatário é CARREGAR (PROCURAR é a do remetente) e só acha o
//   CPF/CNPJ com máscara; por CPF vem só o nome: o endereço sai pelo CEP, pela
//   mesma busca da janelinha "informar endereço" (ENDERECO_INTERNET_PSQ);
// - município de início do transporte: busca SELECAO_007 (opcional, o MAGNU não usa);
// - itens: formulário de 10 linhas (CADASTRO_037), preenchido como o MAGNU faz;
// - Transporte: modalidade 1 Próprio, 3 Contratado, 4 Tangido; frete por conta
//   1 Remetente, 2 Destinatário, 3 Terceiros (rádios).
// TESTE DE PONTA A PONTA (15/10/2026, dados fictícios, servidor local + login da pessoa):
// esta corda rodou do login até a pausa antes do FINALIZAR — 2 produtos gravados
// (total 400,00), comprador por CPF + endereço por CEP, transporte e adicionais
// preenchidos — e o pedido foi desistido. Lições: a gravação do endereço e alguns
// rádios do Transporte RECARREGAM a aba; o passo seguinte só depois da recarga,
// senão o SIARE volta para a tela inicial.
// Ainda não visto: só o FINALIZAR (só com uma nota de verdade).
import { BASE, pedeLogin } from './navegador.mjs';
import {
  acao, acaoDoBotao, buscarNaPagina, cpfCnpjComMascara, dormir, escolher, esperarCampo, lupaDaLinha, ondeParou, radio, radioComRecarga, selectsErrados, SOL, texto,
} from './siare-dom.mjs';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

// ---------------- tradução dos dados para os campos do SIARE (puro, testável) ----------------

/** Dinheiro: 4 casas, vírgula decimal ("0,9000"). */
export const valorDoPortal = (v) => Number(v || 0).toFixed(4).replace('.', ',');
/** Dinheiro dos totais (frete, seguro...): 2 casas. */
export const totalDoPortal = (v) => Number(v || 0).toFixed(2).replace('.', ',');
/** Quantidade: vírgula decimal, sem zeros à toa ("2400", "10,5"). */
export const quantidadeDoPortal = (q) => String(Number(q || 0)).replace('.', ',');
/** Peso: o SIARE usa 2 casas implícitas (6.300,00 → 630000). */
export const pesoDoPortal = (p) => String(Math.round(Number(p || 0) * 100));
/** Alíquota dos selects de frete/crédito: "4" → "4.0". */
export const aliquotaDoPortal = (a) => Number(String(a).replace(',', '.') || 0).toFixed(1);
const sn = (b) => (b ? 'S' : 'N');
const tf = (b) => (b ? 'true' : 'false');
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Campos da etapa "Informações Básicas" (SERVICO_076). */
export function camposBasicos(e) {
  return {
    rdgTipoNFA: tf(e.tipoNFA === 'entrada'),
    tipoCirculacao: String(e.circulacao ?? ''),
    tipoNatureza: String(e.natureza ?? ''),
    // O app esconde a finalidade na devolução e manda a certa em _derivado (4).
    finalidadeEmissao: String((e._derivado && e._derivado.finalidade) || e.finalidade || (String(e.natureza) === '7' ? '4' : '')),
    rdgSuframa: tf(!!e.suframa),
    rdgRegimeEspecial: tf(!!e.regimeEspecial),
  };
}

/** Campos da etapa "Dados Iniciais" (CFOP e data). */
export function camposDadosIniciais(e) {
  const c = { 'cfop.id': String(e.cfop ?? ''), dataSaidaEntrada: e.dataSaida || '' };
  if (e.tipoNFA !== 'entrada' && e.horaSaida) c.horaSaida = e.horaSaida;
  if (e.orgaoPublico) { c.vendaOrgaoPublico = 'true'; if (e.notaEmpenho) c.notaEmpenho = e.notaEmpenho; }
  return c;
}

/** Uma linha do formulário de itens CADASTRO_037. */
export function camposItem(it) {
  return {
    cmbGrupo: String(it.grupoCodigo || it.grupo || ''),
    'subItemNcm.codigo': digitos(it.ncm),
    descricao: String(it.descricao ?? '').slice(0, 60),
    cmbOrigem: String(it.origem ?? '0'),
    cmbUnidadeMedida: String(it.unidade ?? ''),
    quantidade: quantidadeDoPortal(it.quantidade),
    valorUnitario: valorDoPortal(it.valorUnitario),
    // Só existem no "Requerer NFA" (exterior): unidade/quantidade/valor comerciais,
    // iguais aos tributáveis. Nas outras telas esses campos não aparecem.
    cmbUnidadeMedidaComercial: String(it.unidade ?? ''),
    quantidadeComercial: quantidadeDoPortal(it.quantidade),
    valorUnitarioComercial: valorDoPortal(it.valorUnitario),
  };
}

/** Número do app ("0,7129", "12", 30) → valor das listas do SIARE ("0.7129", "12.0", "30.0"). */
export function percentualDoPortal(v) {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * Imposto de um item na grade da aba Produtos (só o que veio):
 * CST "00" → "0" (a lista do SIARE usa 0, 10, 20…), alíquota, redução de base e
 * crédito presumido no formato das listas.
 */
export function tributacaoDoItem(it) {
  const t = {};
  if (it.cst != null && it.cst !== '') t.cst = String(Number(it.cst));
  for (const [app, siare] of [['aliquota', 'aliquota'], ['reducao', 'bc'], ['credPres', 'credPres'], ['aliqInterest', 'aliqInterest']]) {
    const v = percentualDoPortal(it[app]);
    if (v) t[siare] = v;
  }
  // Consumidor final de outro estado (DIFAL/FCP): campos de texto da mesma linha da
  // grade, que só aparecem nessa operação (conferidos em 15/10/2026).
  // Número já vem do app como number; texto pode trazer "1.220,50".
  const num = (v) => (typeof v === 'number' ? v : Number(String(v).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')));
  const difal = {};
  for (const [app, siare] of [['aliqInternaDest', 'aliqInternaUFDest'], ['bcDest', 'valBCIcmsUFDest'], ['fcp', 'aliqFCPUFDest']]) {
    if (it[app] == null || it[app] === '' || !Number.isFinite(num(it[app]))) continue;
    difal[siare] = num(it[app]).toFixed(2).replace('.', ',');
  }
  if (Object.keys(difal).length) t.difal = difal;
  return t;
}

/** Desconto de cada item, em reais (aceita "415,08" ou 415.08). */
export function descontosDosItens(itens) {
  return (itens || []).map((it) => {
    const v = it.desconto;
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  });
}

/** Totais da aba Produtos (frete, seguro, outras despesas...). Só o que veio. */
export function camposTotais(e) {
  const c = {};
  const dinheiro = [['valorFrete', 'valorFrete'], ['valorSeguro', 'valorSeguro'], ['outrasDespesas', 'outrasDespAcessorias'], ['valorIpi', 'valorTotalIpi'], ['baseIcmsST', 'baseCalcIcmsST'], ['valorIcmsST', 'valorIcmsST'], ['certificadoCreditoPR', 'certificadoCreditoPR']];
  for (const [app, siare] of dinheiro) if (e[app] != null && e[app] !== '') c[siare] = totalDoPortal(e[app]);
  if (e.aliquotaFrete != null && e.aliquotaFrete !== '') c['aliquotaBCFrete.valorString'] = aliquotaDoPortal(e.aliquotaFrete);
  if (e.credPresFrete != null && e.credPresFrete !== '') c['aliquotaBCCreditoPresumido.valorString'] = aliquotaDoPortal(e.credPresFrete);
  return c;
}

/**
 * Nota que está sendo devolvida (aba Dados Adicionais, bloco "documento de
 * aquisição/recebimento", nomes conferidos na tela em 15/10/2026):
 * 3 NF-e e 4 NFA-e → chave de 44 dígitos; 1 NF modelo 1/1A e 2 avulsa de papel →
 * número, série, modelo, CNPJ do emitente e mês/ano; 6 cupom → COO, ECF e código.
 * Devolve { tipo, campos: [[nome, valor]], lista: [[nome, valor]] } (só o que veio).
 */
export function camposDevolucao(ref) {
  const r = ref || {};
  const tipo = String(r.tipo ?? '');
  const campos = [];
  const lista = [];
  const p = (nome, v) => { if (v != null && String(v) !== '') campos.push([nome, String(v)]); };
  if (tipo === '3' || tipo === '4') p('devolucaoNFA.chaveAcesso', digitos(r.chave));
  if (tipo === '1' || tipo === '2') {
    p('devolucaoNFA.numeroDocumentoFiscal', digitos(r.numero));
    p('devolucaoNFA.serieDocumentoFiscal', digitos(r.serie));
    p('devolucaoNFA.modeloDocumentoFiscal', digitos(r.modelo));
    const cnpj = digitos(r.cnpjEmitente);
    p('devolucaoNFA.cnpjEmitente', cnpj.length === 14 ? cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : cnpj);
    const ma = digitos(r.mesAno);
    p('devolucaoNFA.mesAnoDocumentoFiscal', ma.length === 4 ? ma.slice(0, 2) + '/' + ma.slice(2) : r.mesAno);
    lista.push(['devolucaoNFA.codigoIbgeUfEmitente', '31']); // a tela só oferece MG
  }
  if (tipo === '6') {
    p('devolucaoNFA.numeroCOO', digitos(r.coo));
    p('devolucaoNFA.numeroEquipamentoEmissor', digitos(r.ecf));
    const cod = { '2B': '8', '2C': '9', '2D': '10' }[String(r.codigoEcf || '').toUpperCase()];
    if (cod) lista.push(['devolucaoNFA.tipoCupomFiscal.identificador', cod]);
  }
  return { tipo, campos, lista };
}

/**
 * Destinatário no exterior (aba Remetente/Destinatário do "Requerer NFA" com
 * circulação Exterior, nomes lidos em 15/10/2026). Devolve os textos, o país
 * (nome ou código, casado na lista do SIARE na hora) e a UF de embarque.
 */
export function camposEstrangeiro(op, e) {
  const o = op || {};
  const x = e || {};
  const textos = [];
  const p = (nome, v, max) => { if (v != null && String(v).trim() !== '') textos.push([nome, String(v).trim().slice(0, max)]); };
  p('destinatario.nome', o.nome, 60);
  p('destinatario.idEstrangeiro', o.idEstrangeiro, 20);
  p('destinatario.foneFax', digitos(o.fone), 13);
  p('enderecoDestinatario.municipio', o.cidade || o.municipio, 40);
  p('enderecoDestinatario.bairro', o.bairro, 60);
  p('enderecoDestinatario.logradouro', o.logradouro, 120);
  p('enderecoDestinatario.numero', o.numero, 6);
  p('enderecoDestinatario.complemento1', o.complemento, 26);
  p('enderecoDestinatario.localEmbarque', x.localEmbarque || o.localEmbarque, 60);
  return { textos, pais: String(o.pais ?? '').trim(), ufEmbarque: String(x.ufEmbarque || o.ufEmbarque || '').trim().toUpperCase() };
}

/** Qual lado é a "outra parte": saída → destinatário; entrada → remetente. */
export const ladoDaOutraParte = (e) => (e.tipoNFA === 'entrada' ? 'remetente' : 'destinatario');
const comMaiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Tipo de logradouro pela 1ª palavra do endereço, entre os que o SIARE aceita
 * ("FAZENDA BOA VISTA" → FAZENDA + "BOA VISTA"). Sem casar, usa OUTROS.
 */
export function tipoDeLogradouro(logradouro, tipos) {
  const alvo = semAcento(logradouro);
  const lista = (tipos || []).map((t) => [t, semAcento(t)]).filter(([, n]) => n).sort((a, b) => b[1].length - a[1].length);
  for (const [t, n] of lista) {
    if (alvo === n || alvo.startsWith(n + ' ')) return { tipo: t, resto: String(logradouro).trim().slice(n.length).trim() || String(logradouro).trim() };
  }
  const outros = (tipos || []).find((t) => semAcento(t) === 'OUTROS');
  return { tipo: outros || '', resto: String(logradouro ?? '').trim() };
}

/**
 * Linha que a janelinha "informar endereço" devolve para a nota (29 partes
 * separadas por vírgula; ordem de enviarDados()/mudarValorDestinatario()).
 */
export function linhaDeEndereco(d) {
  const p = (v) => String(v ?? '').replace(/,/g, ' ').trim();
  const partes = [digitos(d.cep), d.sgUf, d.nomeUF, d.idMunicipio, d.nomeMunicipio, d.distrito, d.bairro, d.tipoLogradouro, d.logradouro, d.numero || 'S/N', ''];
  while (partes.length < 29) partes.push(''); // 6 complementos × (código, tipo, texto)
  return partes.map(p).join(',');
}

/** "Jaíba/MG", "JAIBA - MG" ou "Jaíba" → { nome, uf }. */
export function municipioEUf(s) {
  const m = String(s ?? '').trim().match(/^(.*?)(?:\s*[/\-–]\s*([A-Za-z]{2}))?$/);
  return { nome: semAcento(m ? m[1] : s), uf: m && m[2] ? m[2].toUpperCase() : 'MG' };
}

// ---------------- a corda ----------------

export async function emitirNfa({ page, entradas, etapa, evidencia, guardarArquivo, pausar, previaApp }) {
  const e = entradas || {};
  const lado = ladoDaOutraParte(e); // destinatario | remetente
  const outro = lado;
  const eu = lado === 'destinatario' ? 'remetente' : 'destinatario';
  const quem = lado === 'destinatario' ? 'recebe' : 'envia';

  if (!Array.isArray(e.itens) || !e.itens.length) throw new Error('A nota não tem nenhum produto.');
  // Exterior só sai pelo "Requerer NFA" (SERVICO_070): a Emissão Especial não aceita
  // Exterior. As abas seguintes são as mesmas (conferido em 15/10/2026), com o
  // destinatário estrangeiro e sem imposto nem desconto por item.
  const exterior = String(e.circulacao) === '3';
  const SERV = exterior ? 'SERVICO_070' : 'SERVICO_076';
  const ABRIR = exterior ? SOL + '/NFAE/SERVICO_070?ACAO=NOVO' : SOL + '/NFAE/SERVICO_076?ACAO=NOVO&SINDCOOPPRODRURAL=1';
  // O e-mail do produtor é exigido no FINALIZAR; falha cedo, antes de qualquer passo.
  if (!e.produtor?.email) throw new Error('Falta o e-mail para o retorno da nota.');
  const op = e.outraParte || {};
  // No app, quem recebe no exterior vem no bloco `exterior` (endereço livre, país da lista).
  const ext = e.exterior
    ? { nome: e.exterior.nome, idEstrangeiro: e.exterior.idEstrangeiro, fone: e.exterior.fone, pais: e.exterior.pais, cidade: e.exterior.cidade, bairro: e.exterior.bairro, logradouro: e.exterior.endereco, numero: e.exterior.numero, complemento: e.exterior.complemento, localEmbarque: e.exterior.localEmbarque, ufEmbarque: e.exterior.ufEmbarque }
    : op;
  if (exterior) {
    if (e.tipoNFA === 'entrada') throw new Error('Nota de entrada do exterior não sai pelo app. Nada foi feito.');
    if (!ext.nome || !ext.pais) throw new Error('Falta o nome e o país de quem recebe no exterior.');
    if (descontosDosItens(e.itens).some((d) => d > 0)) throw new Error('Na nota para outro país o SIARE não tem desconto por item. Nada foi feito.');
  } else if (!op.ie && !op.cpfCnpj) throw new Error(`Falta o CPF/CNPJ de quem ${quem}.`);
  if (String(e.natureza) === '7' && !camposDevolucao(e.docRef).campos.length) throw new Error('Falta a nota que está sendo devolvida.');

  // 1) Abrir a Emissão Especial (já logado) e 2) Informações básicas → CONFNOVO.
  //    Entrada/Saída primeiro (troca as listas); "Recuperar" nunca é clicado.
  //    "Ação inválida" neste CONFNOVO costuma ser passageira (MAGNU: 6 de 18 notas
  //    em 25/09 saíram ao repetir) e nada foi finalizado: repete até 3 vezes.
  const bas = camposBasicos(e);
  const listas = { tipoCirculacao: bas.tipoCirculacao, tipoNatureza: bas.tipoNatureza, finalidadeEmissao: bas.finalidadeEmissao };
  for (let tentativa = 1; ; tentativa++) {
    etapa(tentativa === 1 ? 'Abrindo a emissão de NFA' : `Abrindo a emissão de novo (${tentativa}ª vez)`);
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }).catch(() => null);
    await page.goto(ABRIR, { waitUntil: 'load', timeout: 90000 });
    await nav;
    if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a emissão.');
    if (!(await esperarCampo(page, 'select[name="tipoCirculacao"]'))) throw new Error('A tela de emissão não abriu (sem Tipo de Circulação).');

    etapa('Dados básicos da nota');
    await radio(page, 'rdgTipoNFA', bas.rdgTipoNFA);
    await dormir(300);
    for (const [n, v] of Object.entries(listas)) await escolher(page, n, v);
    await radio(page, 'rdgSuframa', bas.rdgSuframa);
    await radio(page, 'rdgRegimeEspecial', bas.rdgRegimeEspecial);
    await dormir(300);
    for (const n of await selectsErrados(page, listas)) await escolher(page, n, listas[n]);
    const faltou = await selectsErrados(page, listas);
    if (faltou.length) throw new Error('O SIARE não aceitou a escolha de: ' + faltou.join(', ') + '.');
    try {
      await acao(page, { url: SOL + '/NFAE/' + SERV, acaoSiare: 'CONFNOVO', valida: true, prova: 'select[name="cfop.id"], [name="cfop.id"]' });
      break;
    } catch (err) {
      if (tentativa >= 3 || !/a[çc][ãa]o inv[áa]lida/i.test(err.message)) throw err;
      await dormir(20000);
    }
  }

  // 3) Dados iniciais: CFOP e data → aba Remetente/Destinatário.
  etapa('CFOP e data');
  const di = camposDadosIniciais(e);
  if ((await escolher(page, 'cfop.id', di['cfop.id'])) !== di['cfop.id']) throw new Error(`O CFOP ${di['cfop.id']} não está na lista do SIARE para esta nota.`);
  await texto(page, 'dataSaidaEntrada', di.dataSaidaEntrada, true);
  if (di.horaSaida) await texto(page, 'horaSaida', di.horaSaida, true);
  if (di.vendaOrgaoPublico) { await radio(page, 'vendaOrgaoPublico', 'true'); if (di.notaEmpenho) await texto(page, 'notaEmpenho', di.notaEmpenho); }
  await acao(page, { url: SOL + '/NFAE/SERVICO_027', acaoSiare: 'VISUALIZAR', prova: exterior ? '[name="destinatario.idEstrangeiro"], [name="destinatario.nome"]' : `[name="${outro}.cpfCnpj"], [name="${outro}.ie"]` });

  // 4) Quem recebe/envia: e-mail do produtor primeiro (exigido no fim), depois a busca.
  etapa('Quem ' + quem);
  await texto(page, `${eu}.email`, e.produtor?.email);
  if (e.produtor?.fone) await texto(page, `${eu}.foneFax`, digitos(e.produtor.fone));

  if (exterior) {
    // Estrangeiro: sem busca; os campos são digitados e o país sai da lista do SIARE.
    const est = camposEstrangeiro(ext, e);
    for (const [n, v] of est.textos) await texto(page, n, v);
    const pais = await page.evaluate((alvo) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
      const sel = document.querySelector('select[name="enderecoDestinatario.paisCompleto.identificador"]');
      if (!sel) return null;
      const ops = Array.from(sel.options).filter((o) => o.value);
      const a = norm(alvo);
      const o = ops.find((x) => x.value === alvo) || ops.find((x) => norm(x.text) === a) || ops.find((x) => norm(x.text).startsWith(a));
      return o ? o.value : '';
    }, est.pais).catch(() => null);
    if (!pais) throw new Error(`O país "${est.pais}" não está na lista do SIARE.`);
    if ((await escolher(page, 'enderecoDestinatario.paisCompleto.identificador', pais)) !== pais) throw new Error('O SIARE não aceitou o país.');
    if (est.ufEmbarque) await escolher(page, 'enderecoDestinatario.ufEmbarque', est.ufEmbarque);
    if (e.municipioInicioTransporte) await municipioInicio(page, e.municipioInicioTransporte);
    await evidencia('destinatario');
  } else {
  // IE primeiro (contribuinte só carrega por IE — MAGNU), depois CPF/CNPJ com máscara.
  let nome = '';
  let recusa = '';
  if (op.ie) {
    await texto(page, `${outro}.ie`, digitos(op.ie));
    ({ nome, recusa } = await buscarOutraParte(page, outro, `${outro}.ie`));
  }
  if (!nome && op.cpfCnpj) {
    await texto(page, `${outro}.cpfCnpj`, cpfCnpjComMascara(op.cpfCnpj));
    ({ nome, recusa } = await buscarOutraParte(page, outro, `${outro}.cpfCnpj`));
  }
  // Ninguém achou (1ª nota para essa pessoa): nome digitado no app.
  if (!nome && op.nome) {
    nome = await page.evaluate((o, v) => {
      const el = document.querySelector(`[name="${o}.nome"]`);
      if (!el) return '';
      el.value = v;
      const vis = document.getElementById(`${o}.nome`);
      if (vis && vis !== el) vis.textContent = v;
      return el.value;
    }, outro, String(op.nome).slice(0, 60)).catch(() => '');
  }
  if (!nome) throw new Error(`O SIARE não achou quem ${quem}${recusa ? ' (' + recusa + ')' : ''}. Informe o nome e o endereço.`);
  await evidencia('destinatario-busca');

  // Endereço: por CPF o SIARE só traz o nome. Sem endereço, busca pelo CEP.
  const Lado = comMaiuscula(outro);
  const temEndereco = await page.evaluate((L) => !!((document.querySelector(`[name="endereco${L}.idMunicipio"]`) || {}).value || '').trim(), Lado).catch(() => false);
  if (!temEndereco) { await enderecoPeloCep(page, outro, op, quem); await evidencia('destinatario-endereco'); }

  // Dados complementares.
  if (op.fone) await texto(page, `${outro}.foneFax`, digitos(op.fone));
  if (op.consumidorFinal != null) await radio(page, 'flOperacaoConsumidorFinal', sn(op.consumidorFinal));
  if (op.tipoIE) await escolher(page, `${outro}.tipoIdentificadorIeDestinatario.id`, String(op.tipoIE));
  // "Operação com Crédito Presumido?" e o ressarcimento são OBRIGATÓRIOS quando
  // aparecem (destinatário contribuinte): sem resposta o FINALIZAR é recusado
  // (visto em 15/10/2026). Padrão "Não", como o MAGNU.
  const naRemDest = `[name="${outro}.cpfCnpj"], [name="${outro}.ie"]`;
  await radioComRecarga(page, 'destIndustriaCooperativa', tf(!!e.credPresumido), naRemDest);
  await radioComRecarga(page, 'ressarcimentoCredPresumido', tf(!!e.ressarcimentoCredPres), naRemDest);
  if (e.tipoDestCredPres) await escolher(page, `${outro}.tipoDestinatarioNFA.identificador`, String(e.tipoDestCredPres));
  if (e.municipioInicioTransporte) await municipioInicio(page, e.municipioInicioTransporte);
  await evidencia('destinatario');
  }

  // 5) Produtos: formulário de 10 linhas por vez, como o MAGNU (que emite em produção).
  etapa('Produtos');
  await acao(page, { url: SOL + '/NFAE/SERVICO_037' + (exterior ? '?tipoCirculacao=3' : ''), acaoSiare: 'EXIBIRFLT', prova: 'img[src*="ic_novo"], a[onclick*="NOVO"]' });
  for (let ini = 0; ini < e.itens.length; ini += 10) {
    const lote = e.itens.slice(ini, ini + 10).map(camposItem);
    await acao(page, { url: SOL + '/NFAE/CADASTRO_037?tipoCirculacao=' + encodeURIComponent(e.circulacao || '1'), acaoSiare: 'NOVO', prova: '[name="descricao"], [name="subItemNcm.codigo"]' });
    await page.evaluate((linhas) => {
      const f = document.formTela || document;
      const todos = (n) => f.querySelectorAll(`[name="${n}"]`);
      const lista = (sel, v) => {
        if (!sel || v == null || v === '') return;
        const op = Array.from(sel.options).find((o) => o.value === v);
        if (op) { sel.value = op.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      };
      linhas.forEach((c, i) => {
        lista(todos('cmbGrupo')[i], c.cmbGrupo);
        const campo = (n) => { const el = todos(n)[i]; if (el) el.value = c[n]; };
        campo('subItemNcm.codigo');
        campo('descricao');
        lista(todos('cmbOrigem')[i], c.cmbOrigem);
        lista(todos('cmbUnidadeMedida')[i], c.cmbUnidadeMedida);
        campo('quantidade');
        campo('valorUnitario');
        lista(todos('cmbUnidadeMedidaComercial')[i], c.cmbUnidadeMedidaComercial);
        campo('quantidadeComercial');
        campo('valorUnitarioComercial');
      });
    }, lote);
    await dormir(300);
    // A validação do próprio SIARE; se ela quebrar (já quebrou: "ehEditar"), segue.
    const val = await page.evaluate(() => {
      window.__avisos = [];
      window.alert = (m) => window.__avisos.push(String(m));
      window.confirm = () => true;
      try { return { ok: typeof validacaoItens !== 'function' || validacaoItens() !== false, avisos: window.__avisos }; } catch { return { ok: true, avisos: [] }; }
    });
    if (!val.ok) { await evidencia('produtos-recusados'); throw new Error('O SIARE recusou os produtos: ' + (val.avisos.join(' ') || 'confira os campos') + ' Nada foi enviado.'); }
    await acao(page, { url: SOL + '/NFAE/CADASTRO_037', acaoSiare: 'CONFNOVO', prova: 'img[src*="ic_novo"], a[onclick*="NOVO"]' });
  }
  const contados = await page.evaluate(() => {
    const m = ((document.body && document.body.innerText) || '').match(/(\d+)\s*registro/i);
    return m ? Number(m[1]) : null;
  });
  if (contados != null && contados < e.itens.length) {
    await evidencia('produtos-incompletos');
    throw new Error(`O SIARE gravou ${contados} de ${e.itens.length} produtos. Nada foi enviado.`);
  }

  // 5b) Impostos e desconto por produto, na grade da aba Produtos:
  //     CST (a troca RECARREGA a aba e libera alíquota/redução/crédito), depois
  //     alíquota, redução de base, crédito presumido e desconto (valorDescontoItem),
  //     e o "Confirmar" da aba (CONFEDITAR). Confere o que ficou gravado.
  const PROVA_PRODUTOS = 'img[src*="ic_novo"], a[onclick*="NOVO"]';
  const tribsTodos = e.itens.map(tributacaoDoItem);
  const descontosTodos = descontosDosItens(e.itens);
  // A grade mostra 10 produtos por página ("12 registro(s) < 1 de 2 >"): página a página.
  const POR_PAGINA = 10;
  const paginas = Math.max(1, Math.ceil(e.itens.length / POR_PAGINA));
  const ajustesSiare = [];
  for (let pg = 0; pg < paginas; pg++) {
    const ini = pg * POR_PAGINA;
    const tribs = tribsTodos.slice(ini, ini + POR_PAGINA);
    const descontos = descontosTodos.slice(ini, ini + POR_PAGINA);
    if (paginas > 1) { etapa(`Grade: página ${pg + 1}`); await irParaPagina(page, pg + 1, PROVA_PRODUTOS); }
    // NCM que o SIARE não reconhece fica EM BRANCO na grade (visto com 0709.60.10): avisa já.
    const ncms = await page.evaluate(() => Array.from(document.querySelectorAll('input[name="subItemNcm.codigo"]')).filter((c) => c.closest('tr') && c.closest('tr').querySelector('input[type="checkbox"]')).map((c) => c.value.trim()));
    e.itens.slice(ini, ini + POR_PAGINA).forEach((it, k) => {
      if (digitos(it.ncm) && ncms[k] === '') throw new Error(`O SIARE não aceitou o NCM ${it.ncm} (produto ${ini + k + 1}, ${it.descricao}). Nada foi enviado.`);
    });
  // Cada produto é uma LINHA da grade (a que tem a caixinha de seleção): os campos
  // são lidos dentro da linha, nunca pela posição na página (nem toda linha tem
  // todos os campos — visto em 15/10/2026).
  for (let i = 0; i < tribs.length; i++) {
    if (!tribs[i].cst) continue;
    const atual = await page.evaluate((k) => {
      const tr = (Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((c) => c.closest('tr')))[k];
      const s = tr && tr.querySelector('select[name="situacaoTributaria.codSituacaoTributaria"]');
      return s ? s.value : null;
    }, i);
    if (atual == null) throw new Error(`A grade do SIARE não tem a linha ${ini + i + 1} para o imposto.`);
    if (atual === tribs[i].cst) continue;
    etapa(`Imposto do produto ${ini + i + 1}`);
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null);
    const ok = await page.evaluate((k, v) => {
      const tr = (Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((c) => c.closest('tr')))[k];
      const s = tr.querySelector('select[name="situacaoTributaria.codSituacaoTributaria"]');
      if (!Array.from(s.options).some((o) => o.value === v)) return false;
      s.value = v;
      setTimeout(() => s.dispatchEvent(new Event('change', { bubbles: true })), 0);
      return true;
    }, i, tribs[i].cst);
    if (!ok) throw new Error(`O CST ${tribs[i].cst} não está na lista do SIARE (produto ${ini + i + 1}).`);
    await nav;
    await aguardarQuieto(page, PROVA_PRODUTOS);
    if (paginas > 1) await irParaPagina(page, pg + 1, PROVA_PRODUTOS); // a recarga pode voltar à página 1
  }
  const temGrade = tribs.some((t) => t.aliquota || t.bc || t.credPres || t.aliqInterest || t.difal) || descontos.some((d) => d > 0) || tribs.some((t) => t.cst);
  if (temGrade) {
    etapa(descontos.some((d) => d > 0) ? 'Desconto' : 'Impostos por produto');
    const falta = await page.evaluate((ts, ds) => {
      const linhas = Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((c) => c.closest('tr'));
      const todos = (n) => linhas.map((tr) => (tr ? tr.querySelector(`[name="${n}"]`) : null));
      const lista = (n, i, v) => {
        if (!v) return '';
        const s = todos(n)[i];
        if (!s) return ''; // a linha não tem esse campo para este CST: o SIARE decide (vira aviso abaixo)
        if (s.disabled) s.disabled = false; // o SIARE libera conforme o CST; se não liberou, a validação dele avisa
        if (!Array.from(s.options).some((o) => o.value === v)) return `${n}=${v} (linha ${i + 1})`;
        s.value = v;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return '';
      };
      const erros = [];
      ts.forEach((t, i) => {
        for (const [n, v] of [['aliquota.valorString', t.aliquota], ['baseCalculo.valorString', t.bc], ['credPres.valorString', t.credPres], ['aliqInterestUFEnvolvidas.valorString', t.aliqInterest]]) {
          const er = lista(n, i, v);
          if (er) erros.push(er);
        }
        for (const [n, v] of Object.entries(t.difal || {})) {
          const c = todos(n)[i];
          if (!c) { erros.push(`${n} (linha ${i + 1}: só existe em venda a consumidor final de outro estado)`); continue; }
          c.value = v;
          c.dispatchEvent(new Event('change', { bubbles: true }));
          c.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        const d = ds[i];
        const c = todos('valorDescontoItem')[i];
        if (d > 0) {
          if (!c) { erros.push(`desconto da linha ${i + 1}`); return; }
          c.value = d.toFixed(2).replace('.', ',');
          c.dispatchEvent(new Event('change', { bubbles: true }));
          c.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      });
      return erros;
    }, tribs, descontos);
    if (falta.length) throw new Error('A grade do SIARE não aceitou: ' + falta.join('; ') + '. Nada foi enviado.');
    etapa(`Grade: confirmar página ${pg + 1}`);
    await confirmarGrade(page, PROVA_PRODUTOS);
    if (paginas > 1) await irParaPagina(page, pg + 1, PROVA_PRODUTOS); // conferir na página certa
    etapa(`Grade: conferir página ${pg + 1}`);
    // O SIARE pode devolver a grade zerada: confere o que ficou LÁ.
    const g = await page.evaluate(() => {
      const linhas = Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((c) => c.closest('tr'));
      const val = (n) => linhas.map((tr) => { const el = tr && tr.querySelector(`[name="${n}"]`); return el ? el.value : null; });
      return {
        cst: val('situacaoTributaria.codSituacaoTributaria'), aliq: val('aliquota.valorString'), bc: val('baseCalculo.valorString'), cp: val('credPres.valorString'), desc: val('valorDescontoItem'),
        ai: val('aliqInterestUFEnvolvidas.valorString'), aliqInternaUFDest: val('aliqInternaUFDest'), valBCIcmsUFDest: val('valBCIcmsUFDest'), aliqFCPUFDest: val('aliqFCPUFDest'),
      };
    });
    // CST e desconto TÊM de ficar; alíquota/redução/crédito o SIARE ajusta pela regra
    // dele (ex.: zera no CST 51, impõe a alíquota interestadual): vira aviso na prévia.
    const erros = [];
    tribs.forEach((t, i) => {
      const linha = ini + i + 1;
      if (t.cst && g.cst[i] !== t.cst) erros.push(`CST do produto ${linha} ficou ${g.cst[i]}`);
      const n = Number(String(g.desc[i] || '0').replace(/\./g, '').replace(',', '.')) || 0;
      if (descontos[i] > 0 && Math.abs(n - descontos[i]) > 0.01) erros.push(`desconto do produto ${linha} ficou ${g.desc[i] || '0'}`);
      for (const [rot, pedido, ficou] of [['alíquota', t.aliquota, g.aliq[i]], ['redução de base', t.bc, g.bc[i]], ['crédito presumido', t.credPres, g.cp[i]], ['alíquota interestadual', t.aliqInterest, g.ai[i]]]) {
        if (pedido && ficou !== pedido) ajustesSiare.push(`Produto ${linha}: o SIARE pôs ${rot} ${ficou == null ? '(sem campo)' : ficou + '%'} (pedido ${pedido}%)`);
      }
      const ROT_DIFAL = { aliqInternaUFDest: 'alíquota interna do destino', valBCIcmsUFDest: 'base do ICMS no destino', aliqFCPUFDest: 'FCP do destino' };
      for (const [n, pedido] of Object.entries(t.difal || {})) {
        const ficou = g[n][i];
        if (ficou !== pedido) ajustesSiare.push(`Produto ${linha}: o SIARE pôs ${ROT_DIFAL[n]} ${ficou || '(vazio)'} (pedido ${pedido})`);
      }
    });
    if (erros.length) { await evidencia('grade-recusada'); throw new Error('O SIARE não gravou: ' + erros.join('; ') + '. Nada foi enviado.'); }
  }
  }
  if (paginas > 1) { etapa("Grade: voltar à página 1"); await irParaPagina(page, 1, PROVA_PRODUTOS); }

  // 6) Totais da aba Produtos (frete, seguro...), quando houver.
  // Alguns totais fazem o SIARE recalcular e RECARREGAR a aba: um por vez, e se
  // a página navegar, espera ela ficar quieta antes do próximo (visto em 15/10/2026).
  for (const [n, v] of Object.entries(camposTotais(e))) {
    let navegou = false;
    const marca = () => { navegou = true; };
    page.on('framenavigated', marca);
    try {
      if (n.endsWith('.valorString')) await escolher(page, n, v).catch(() => undefined);
      else await texto(page, n, v).catch(() => undefined);
      await dormir(700);
    } finally { page.off('framenavigated', marca); }
    if (navegou) await aguardarQuieto(page, 'img[src*="ic_novo"], a[onclick*="NOVO"]');
    const ficou = await page.evaluate((nome) => ((document.querySelector(`[name="${nome}"]`) || {}).value || ''), n).catch(() => '');
    if (navegou && ficou !== v) {
      // A recarga pode ter vindo antes de o valor ser lido pelo SIARE: põe de novo.
      if (n.endsWith('.valorString')) await escolher(page, n, v).catch(() => undefined);
      else await texto(page, n, v).catch(() => undefined);
      await aguardarQuieto(page, 'img[src*="ic_novo"], a[onclick*="NOVO"]', 1000);
    }
  }
  // "Somar Frete ao Total da NFA" é OBRIGATÓRIO no FINALIZAR, mesmo sem frete: padrão "Não".
  await radioComRecarga(page, 'somarFreteTotalNFA', tf(!!e.somarFrete), 'img[src*="ic_novo"], a[onclick*="NOVO"]');
  // Frete, seguro, outras despesas, ST… só valem com o "Confirmar" da aba (como os
  // impostos): sem ele o SIARE os descarta (visto em 15/10/2026). Confirma e confere.
  const totais = camposTotais(e);
  if (Object.keys(totais).length) {
    etapa('Totais: confirmar');
    // Põe de novo o que a recarga do "Somar frete" possa ter limpado.
    for (const [n, v] of Object.entries(totais)) {
      if (n.endsWith('.valorString')) await escolher(page, n, v).catch(() => undefined);
      else await texto(page, n, v).catch(() => undefined);
    }
    await confirmarGrade(page, 'img[src*="ic_novo"], a[onclick*="NOVO"]');
    const ficou = await page.evaluate((nomes) => Object.fromEntries(nomes.map((n) => [n, ((document.querySelector(`[name="${n}"]`) || {}).value || '').trim()])), Object.keys(totais)).catch(() => ({}));
    const num = (s) => Number(String(s || '0').replace(/\./g, '').replace(',', '.')) || 0;
    const errados = Object.entries(totais).filter(([n, v]) => (n.endsWith('.valorString') ? ficou[n] !== v : Math.abs(num(ficou[n]) - num(v)) > 0.01));
    // O "Confirmar" RECALCULA os totais pelos produtos (ST, seguro, outras despesas
    // já voltaram zerados): o SIARE decide. Vai como aviso na prévia, que mostra o
    // Total da NFA final antes de a pessoa confirmar.
    const ROTULO = { valorFrete: 'frete', valorSeguro: 'seguro', outrasDespAcessorias: 'outras despesas', valorTotalIpi: 'IPI', baseCalcIcmsST: 'base do ICMS ST', valorIcmsST: 'ICMS ST', certificadoCreditoPR: 'certificado de crédito', 'aliquotaBCFrete.valorString': 'alíquota do frete', 'aliquotaBCCreditoPresumido.valorString': 'crédito presumido do frete' };
    for (const [n, v] of errados) ajustesSiare.push(`O SIARE não manteve ${ROTULO[n] || n}: pedido ${v}, ficou ${ficou[n] || 'vazio'}`);
  }
  // A aba pode estar no meio de uma recarga (totais, frete): espera quieta antes da
  // print e da leitura da prévia (senão sai meia página e prévia vazia).
  await aguardarQuieto(page, 'img[src*="ic_novo"], a[onclick*="NOVO"]');
  await esperarCampo(page, '[name="valorFrete"], [name="baseCalcIcmsST"]', 15000);
  await evidencia('produtos');

  // 7) Prévia: lê os totais da tela (melhor-esforço); senão, usa a estimativa do app.
  const lida = (await lerPrevia(page)) || previaApp || null;
  const previa = ajustesSiare.length ? [...(lida || []), ...ajustesSiare.map((a) => ['Atenção', a])] : lida;

  // 8) Transporte. Modalidade primeiro: ela liga/desliga os outros campos.
  etapa('Transporte');
  await acao(page, { url: SOL + '/NFAE/SERVICO_047', acaoSiare: 'VISUALIZAR', prova: '[name="tipoTransporte.identificador"]' });
  // Estes rádios podem recarregar a aba: um de cada vez, esperando a recarga.
  const naTransporte = '[name="tipoTransporte.identificador"]';
  if (e.modalidade) await radioComRecarga(page, 'tipoTransporte.identificador', String(e.modalidade), naTransporte);
  if (e.jaContratado != null) await radioComRecarga(page, 'transporteContratado', tf(e.jaContratado), naTransporte);
  if (e.fretePorConta) await radioComRecarga(page, 'fretePorConta.identificador', String(e.fretePorConta), naTransporte);
  if (e.idTomador) await texto(page, 'identificacaoTomador', e.idTomador);
  if (e.cfopFrete) await escolher(page, 'cfopFrete.id', String(e.cfopFrete));
  if (e.transportador?.cpfCnpj) {
    await texto(page, 'transportador.cpfCnpj', cpfCnpjComMascara(e.transportador.cpfCnpj));
    const lupa = await lupaDaLinha(page, 'transportador.cpfCnpj');
    if (lupa) await acao(page, { url: BASE + lupa.url, acaoSiare: lupa.verbo, prova: '[name="tipoTransporte.identificador"]' }).catch(() => undefined);
  }
  if (e.transportador?.ie) await texto(page, 'transportador.InscEstadual', digitos(e.transportador.ie));
  if (e.veiculo?.placa) await texto(page, 'transportador.placa', String(e.veiculo.placa).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (e.veiculo?.renavam) await texto(page, 'transportador.renavam', digitos(e.veiculo.renavam));
  if (e.veiculo?.uf) await escolher(page, 'transportador.uf', e.veiculo.uf);
  const vol = e.volumes || {};
  if (vol.quantidade) await texto(page, 'quantidadeVlm', String(vol.quantidade));
  if (vol.especie) await texto(page, 'especieVlm', vol.especie);
  if (vol.marca) await texto(page, 'marcaVlm', vol.marca);
  if (vol.numero) await texto(page, 'numeroVlm', vol.numero);
  if (vol.pesoBruto) await texto(page, 'pesoBrutoVlm', pesoDoPortal(vol.pesoBruto));
  if (vol.pesoLiquido) await texto(page, 'pesoLiquidoVlm', pesoDoPortal(vol.pesoLiquido));
  await dormir(500);
  if (!(await esperarCampo(page, naTransporte, 15000))) throw new Error(await ondeParou(page));
  await evidencia('transporte');

  // 9) Adicionais.
  etapa('Informações adicionais');
  await acao(page, { url: SOL + '/NFAE/SERVICO_057', acaoSiare: 'VISUALIZAR', prova: '[name="observacoes"]' });
  if (e.gta) await texto(page, 'gta', e.gta);
  if (e.licencaAmbiental) await texto(page, 'licencaAmbiental', e.licencaAmbiental);
  if (e.observacoes) await texto(page, 'observacoes', e.observacoes);
  // Devolução: a nota devolvida vai no bloco "documento de aquisição/recebimento".
  // O tipo é jquery.selectbox e o onchange troca os campos visíveis.
  const dev = camposDevolucao(e.docRef);
  if (dev.tipo) {
    etapa('Nota que está sendo devolvida');
    if ((await escolher(page, 'devolucaoNFA.tipoDocumentoFiscal.identificador', dev.tipo)) !== dev.tipo) throw new Error('O SIARE não aceitou o tipo da nota devolvida.');
    await dormir(1500);
    for (const [n, v] of dev.lista) await escolher(page, n, v);
    for (const [n, v] of dev.campos) await texto(page, n, v);
    const vazios = await page.evaluate((nomes) => nomes.filter((n) => !((document.querySelector(`[name="${n}"]`) || {}).value || '').trim()), dev.campos.map(([n]) => n)).catch(() => []);
    if (vazios.length) throw new Error('A tela não aceitou os dados da nota devolvida (' + vazios.join(', ') + ').');
    if (Array.isArray(previa)) previa.push(['Nota devolvida', dev.campos.map(([, v]) => v).join(' · ')]);
  }
  await evidencia('conferencia');

  // 10) PONTO SEM RETORNO: para e espera a confirmação da pessoa.
  await pausar(previa);

  // 11) FINALIZAR (só chega aqui depois do /confirmar), com a URL do próprio botão.
  etapa('Enviando à Fazenda');
  await acaoDoBotao(page, 'FINALIZAR', { urlPadrao: SOL + '/NFAE/SERVICO_057', valida: true, tetoMs: 90000 });
  await dormir(2500);

  // 12) Captura protocolo e número; se não vier protocolo, vai para "verificar".
  let protocolo = '';
  let numero = '';
  const ate = Date.now() + 60000;
  while (Date.now() < ate && !protocolo) {
    const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
    protocolo = (txt.match(/[Pp]rotocolo[:\s]*([\d.\-/]+)/) || [])[1] || '';
    numero = numero || (txt.match(/[Nn].mero\s*(?:da\s*)?[Nn]ota[:\s]*([\d.\-/]+)/) || [])[1] || (txt.match(/NFA-e[:\s]*([\d.\-/]+)/) || [])[1] || '';
    if (protocolo) break;
    await dormir(3000);
  }
  await evidencia('resultado');

  if (!protocolo) {
    // A nota pode ter saído. NUNCA reenviar sozinho.
    const erro = new Error('O SIARE não devolveu o protocolo. Confira em "Acompanhar pedidos" antes de repetir.');
    erro.semProtocolo = true;
    throw erro;
  }

  // 13) Documentos na mesma sessão: comprovante do protocolo e DANFE (a NFA só
  //     pode ser impressa até a data de saída). Falhar aqui NÃO desfaz a nota.
  etapa('Baixando a DANFE');
  const info = {};
  const pdfs = await documentosDaNfa({ page, protocolo, guardarArquivo, info }).catch(() => []);
  if (info.numero) numero = info.numero; // a grade vale mais que o texto da tela
  await evidencia('documentos');
  return {
    protocolo,
    ...(numero ? { numero } : {}),
    ...(info.serie ? { serie: info.serie } : {}),
    mensagem: 'Nota enviada à Fazenda.' + (numero ? ` Número ${numero}${info.serie ? ', série ' + info.serie : ''}.` : ''),
    ...(pdfs.length ? { pdfs } : {}),
  };
}

/**
 * Comprovante do protocolo + DANFE de uma NFA emitida (sessão já logada).
 * Testado em 15/10/2026 com a NFA-e 053.510.911.
 */
export async function documentosDaNfa({ page, protocolo, guardarArquivo, info }) {
  const prot = digitos(protocolo);
  const pdfs = [];
  // Comprovante: página HTML de impressão → PDF.
  try {
    const pc = await page.browser().newPage();
    await pc.goto(SOL + '/PROTOCOL/IMPRESSAO_PROTOCOLO?numProtocolo=' + prot + '&ACAO=VISUALIZAR&descServico=Requerimento%20de%20NFA', { waitUntil: 'networkidle2', timeout: 60000 });
    const buf = await pc.pdf({ format: 'A4', printBackground: true });
    await pc.close().catch(() => undefined);
    pdfs.push({ nome: 'Comprovante do protocolo', url: await guardarArquivo('comprovante-protocolo.pdf', buf) });
  } catch { /* segue para a DANFE */ }
  const danfe = await danfePelaTela(page, { tipo: '1', identificacao: prot, info }).catch(() => null);
  if (danfe) pdfs.push({ nome: 'Nota fiscal (DANFE)', url: await guardarArquivo('danfe.pdf', danfe) });
  return pdfs;
}

/**
 * DANFE oficial pela tela "Imprimir Nota Fiscal Avulsa" (SERVICO_068):
 * tipo '1' = protocolo, '0' = número da NFA → Pesquisar → marcar a linha →
 * IMPRIMIR NFA (o botão VISÍVEL; há uma cópia escondida) → popup
 * LISTA_100?ACAO=IMPRIMIR com o PDF. Devolve os bytes ou null.
 */
export async function danfePelaTela(page, { tipo = '1', identificacao, vias, info }) {
  const alvo = digitos(identificacao);
  const browser = page.browser();
  await page.goto(SOL + '/NFAE/SERVICO_068?ACAO=VISUALIZAR', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => undefined);
  if (!(await esperarCampo(page, '[name="identificacao"]', 20000))) throw new Error('A tela Imprimir Nota Fiscal Avulsa não abriu.');
  await page.evaluate((t, v) => {
    const s = document.querySelector('select[name="cmbTpIdentificacao"]');
    if (s) { s.value = t; s.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[name="identificacao"]').value = v;
  }, String(tipo), alvo);
  // Pesquisar recarrega a página: clica fora do evaluate e espera a LINHA da nota.
  await page.evaluate(() => { const img = document.querySelector('img[src*="pesquisar"]'); const a = img && img.closest('a'); setTimeout(() => (a || img) && (a || img).click(), 0); }).catch(() => undefined);
  let achou = false;
  for (const ate = Date.now() + 40000; Date.now() < ate && !achou;) {
    await dormir(800);
    achou = await page.evaluate((p) => !!Array.from(document.querySelectorAll('tr')).find((t) => t.textContent.replace(/\D/g, '').includes(p) && t.querySelector('input[type="checkbox"]')), alvo).catch(() => false);
  }
  if (!achou) throw new Error('A nota não apareceu para impressão (cancelada, de outro produtor ou número errado).');
  await dormir(1000);
  // A grade traz "Número da NFA" e "Número de Série": a tela do FINALIZAR mostra só o
  // protocolo (MAGNU §14), então o número da nota sai daqui.
  if (info) {
    Object.assign(info, await page.evaluate((p) => {
      const tr = Array.from(document.querySelectorAll('tr')).find((t) => t.textContent.replace(/\D/g, '').includes(p) && t.querySelector('input[type="checkbox"]'));
      const cels = tr ? Array.from(tr.cells).map((c) => c.textContent.replace(/\s+/g, ' ').trim()) : [];
      const i = cels.findIndex((c) => /^\d{3}\.\d{3}\.\d{3}$/.test(c));
      return i >= 0 ? { numero: cels[i], serie: /^\d{3}$/.test(cels[i + 1] || '') ? cels[i + 1] : '' } : {};
    }, alvo).catch(() => ({})));
  }
  // "Nº de Vias" (numeroVias: 2 ou 3, padrão 2), depois da pesquisa, que recarrega a tela.
  if (vias && String(vias) !== '2') await escolher(page, 'numeroVias', String(vias));
  const pronto = await page.evaluate((p) => {
    const tr = Array.from(document.querySelectorAll('tr')).find((t) => t.textContent.replace(/\D/g, '').includes(p) && t.querySelector('input[type="checkbox"]'));
    const cb = tr && tr.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
    const img = Array.from(document.querySelectorAll('img[src*="imprimir_NFAe"]')).find((i) => i.offsetParent && i.closest('a'));
    if (img) img.setAttribute('data-af-imprimir', '1');
    return !!(cb && cb.checked && img);
  }, alvo);
  if (!pronto) throw new Error('Não consegui marcar a nota para imprimir.');

  // O PDF abre numa janela nova: pega os bytes da resposta (ou relê a janela).
  let resolver;
  const pdfP = new Promise((r) => { resolver = r; });
  const janelas = [];
  const novaJanela = async (t) => {
    if (t.type() !== 'page') return;
    const pp = await t.page().catch(() => null);
    if (!pp) return;
    janelas.push(pp);
    pp.on('dialog', (d) => d.accept().catch(() => undefined));
    pp.on('response', async (r) => {
      if (!/pdf/i.test(r.headers()['content-type'] || '')) return;
      try { resolver(await r.buffer()); } catch { /* relê abaixo */ }
    });
  };
  browser.on('targetcreated', novaJanela);
  try {
    const botao = await page.$('img[data-af-imprimir="1"]');
    await botao.click();
    let pdf = await Promise.race([pdfP, dormir(25000).then(() => null)]);
    if (!pdf) {
      const pp = janelas.find((j) => /LISTA_100|ACAO=IMPRIMIR/i.test(j.url())) || janelas[janelas.length - 1];
      if (pp) {
        await dormir(4000);
        const r = await pp.evaluate(async () => {
          const resp = await fetch(location.href, { credentials: 'include', cache: 'force-cache' });
          const b = new Uint8Array(await resp.arrayBuffer());
          let bin = '';
          for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
          return { ct: resp.headers.get('content-type') || '', b64: btoa(bin) };
        }).catch(() => ({ ct: '', b64: '' }));
        if (/pdf/i.test(r.ct)) pdf = Buffer.from(r.b64, 'base64');
      }
    }
    return pdf && pdf.slice(0, 4).toString() === '%PDF' ? pdf : null;
  } finally {
    browser.off('targetcreated', novaJanela);
    for (const j of janelas) await j.close().catch(() => undefined);
  }
}

/**
 * Espera a página ficar QUIETA: nenhuma navegação por `ms` seguidos. A grade de
 * produtos às vezes recarrega duas vezes (CST, página, Confirmar); seguir no meio
 * disso faz o SIARE receber dois envios e voltar para a tela inicial.
 */
async function aguardarQuieto(page, prova, ms = 1500) {
  let mudou = true;
  const marca = () => { mudou = true; };
  page.on('framenavigated', marca);
  try {
    for (let k = 0; k < 20 && mudou; k++) { mudou = false; await dormir(ms); }
  } finally { page.off('framenavigated', marca); }
  // A aba de produtos às vezes chega aos poucos (só o título primeiro): espera ela
  // terminar de carregar de verdade (visto em 15/10/2026).
  for (const ate = Date.now() + 60000; Date.now() < ate;) {
    const pronto = await page.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (pronto) break;
    await dormir(700);
  }
  if (prova && !(await esperarCampo(page, prova, 30000))) throw new Error(await ondeParou(page));
}

/** O "Confirmar" da grade (CONFEDITAR), com clique do próprio botão e espera da página quieta. */
async function confirmarGrade(page, prova) {
  await aguardarQuieto(page, prova, 1000);
  const temBotao = () => page.evaluate(() => Array.from(document.querySelectorAll('a[onclick], img[onclick]')).some((el) => /'CONFEDITAR'/.test(el.getAttribute('onclick') || ''))).catch(() => false);
  for (const ate = Date.now() + 15000; Date.now() < ate && !(await temBotao());) await dormir(700);
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => null);
  const ok = await page.evaluate(() => {
    for (const el of document.querySelectorAll('a[onclick], img[onclick]')) {
      const oc = el.getAttribute('onclick') || '';
      if (/'CONFEDITAR'/.test(oc)) { setTimeout(() => el.click(), 0); return true; }
    }
    return false;
  }).catch(() => false);
  if (!ok) throw new Error('Não achei o botão Confirmar da grade de produtos.');
  await nav;
  await aguardarQuieto(page, prova);
  const erro = await page.evaluate(() => {
    const t = (document.body && document.body.innerText) || '';
    const l = t.split(/\r?\n/).map((x) => x.trim()).find((x) => /inválid|obrigat|não pode|deverá/i.test(x));
    return l || '';
  }).catch(() => '');
  if (erro) throw new Error('O SIARE recusou: ' + erro.slice(0, 200));
}

/** Página da grade de produtos ("12 registro(s) < 1 de 2 > [ ] Ir"). */
async function irParaPagina(page, n, prova) {
  await aguardarQuieto(page, prova);
  const atual = async () => page.evaluate(() => {
    const m = ((document.body && document.body.innerText) || '').match(/registro\(s\)\s*<?\s*(\d+)\s*de\s*(\d+)/i);
    return m ? Number(m[1]) : 1;
  }).catch(() => 0);
  for (let passo = 0; passo < 6; passo++) {
    const agora = await atual();
    if (agora === n) return;
    // As setas "<" e ">" ficam na mesma faixa do "N registro(s)"; sem elas, o campo + "Ir".
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => null);
    const como = await page.evaluate((num, frente) => {
      const faixa = Array.from(document.querySelectorAll('td, div, span, th')).filter((el) => /registro\(s\)/i.test(el.textContent || '')).sort((a, b) => a.textContent.length - b.textContent.length)[0];
      const caixa = faixa ? (faixa.closest('tr') || faixa.parentElement) : document.body;
      const seta = Array.from(caixa.querySelectorAll('a, img, input[type="image"]')).find((el) => String(el.textContent || el.alt || el.title || el.value || '').trim() === (frente ? '>' : '<'));
      if (seta) { setTimeout(() => (seta.closest('a') || seta).click(), 0); return 'seta'; }
      const campo = caixa.querySelector('input[type="text"]') || document.querySelector('input[name^="ufw_posic"]');
      const ir = Array.from(caixa.querySelectorAll('a, input[type="button"], input[type="image"], img')).find((el) => /^ir$/i.test(String(el.textContent || el.value || el.alt || el.title || '').trim()));
      if (campo && ir) { campo.value = String(num); setTimeout(() => (ir.closest('a') || ir).click(), 0); return 'ir'; }
      return '';
    }, n, n > agora);
    if (!como) throw new Error('Não achei a paginação da grade de produtos.');
    await nav;
    await aguardarQuieto(page, prova);
  }
  if ((await atual()) !== n) throw new Error(`A grade de produtos não foi para a página ${n}.`);
}

/** Lupa da outra parte (CARREGAR no destinatário) e espera o nome aparecer. */
async function buscarOutraParte(page, outro, campo) {
  const lupa = (await lupaDaLinha(page, campo)) || { url: '/sol/ctrl/SOL/NFAE/SERVICO_027', verbo: outro === 'destinatario' ? 'CARREGAR' : 'PROCURAR' };
  let recusa = '';
  try {
    await acao(page, { url: BASE + lupa.url, acaoSiare: lupa.verbo, tetoMs: 30000, prova: `[name="${outro}.cpfCnpj"], [name="${outro}.ie"]` });
  } catch (err) {
    // Só a recusa da busca vira "não achou"; sair da tela é erro de verdade.
    if (!/^O SIARE recusou: /.test(String(err.message))) throw err;
    recusa = String(err.message).replace(/^O SIARE recusou: /, '');
  }
  const ate = Date.now() + 18000; // o SIARE pode demorar a responder a busca
  while (Date.now() < ate) {
    const nome = await page.evaluate((o) => ((document.querySelector(`[name="${o}.nome"]`) || {}).value || '').trim(), outro).catch(() => '');
    if (nome) return { nome, recusa: '' };
    if (recusa) break;
    await dormir(1500);
  }
  return { nome: '', recusa };
}

/** Endereço pela busca de CEP do SIARE; preenche a nota com a função da própria tela. */
/**
 * Linha de endereço (29 partes) pela mesma busca da janelinha "informar endereço"
 * (ENDERECO_INTERNET_PSQ, POST do CEP com EXIBIRFLT). `abrir` é a URL da janelinha
 * com a função de retorno da tela. Serve à nota e a outras telas (ex.: dar acesso).
 */
export async function linhaPeloCep(page, op, abrir, quem = 'a pessoa') {
  const cep = digitos(op.cep);
  if (cep.length !== 8) throw new Error(`Informe o CEP de ${quem}.`);
  if (!String(op.logradouro || '').trim() || !String(op.bairro || '').trim()) throw new Error(`Informe o endereço e o bairro de ${quem}.`);
  const html = await buscarNaPagina(page, { abrir, enviar: SOL + '/RETAGUAR/ENDERECO_INTERNET_PSQ', campos: { cep, ACAO: 'EXIBIRFLT' } });
  const achado = await page.evaluate((h) => {
    const d = new DOMParser().parseFromString(h, 'text/html');
    const oculto = (n) => ((d.querySelector(`input[type=hidden][name="${n}"]`) || {}).value || '').trim();
    const tipos = Array.from((d.querySelector('select[name="tipoLogradouro.identificador"]') || { options: [] }).options).map((o) => o.text.trim()).filter(Boolean);
    return { idMunicipio: oculto('idMunicipio'), sgUf: oculto('sgUf'), nomeUF: oculto('nomeUF'), nomeMunicipio: oculto('nomeMunicipio'), tipos };
  }, html);
  if (!achado.idMunicipio) throw new Error(`O SIARE não achou o CEP ${cep}.`);
  const { tipo, resto } = tipoDeLogradouro(op.logradouro || '', achado.tipos);
  return linhaDeEndereco({ cep, ...achado, distrito: '', bairro: op.bairro, tipoLogradouro: tipo, logradouro: resto, numero: op.numero });
}

async function enderecoPeloCep(page, outro, op, quem) {
  if (digitos(op.cep).length !== 8) throw new Error(`O SIARE não trouxe o endereço de quem ${quem}. Informe o CEP.`);
  const Lado = comMaiuscula(outro);
  const abrir = `${SOL}/RETAGUAR/ENDERECO_INTERNET_PSQ?funcaoRetorno=opener.mudarValor${Lado}&getDadosEnd=opener.getDadosEnd${Lado}&ACAO=VISUALIZAR`;
  const linha = await linhaPeloCep(page, op, abrir, 'quem ' + quem);
  // A função da própria tela grava o endereço e RECARREGA a aba (ACAO=VISUALIZAR + submit):
  // espera a recarga antes de mexer em qualquer outro campo.
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => null);
  const chamou = await page.evaluate((fn, l) => {
    if (typeof window[fn] !== 'function') return false;
    setTimeout(() => window[fn](l), 0);
    return true;
  }, 'mudarValor' + Lado, linha);
  if (!chamou) throw new Error(`Não consegui pôr o endereço de quem ${quem} na nota.`);
  await nav;
  if (!(await esperarCampo(page, `[name="${outro}.cpfCnpj"], [name="${outro}.ie"]`, 30000))) throw new Error(await ondeParou(page));
  const gravou = await page.evaluate((L) => !!((document.querySelector(`[name="endereco${L}.idMunicipio"]`) || {}).value || '').trim(), Lado).catch(() => false);
  if (!gravou) throw new Error(`O SIARE não guardou o endereço de quem ${quem}.`);
}

/** Município de início do transporte pela busca SELECAO_007 (sem abrir a janelinha). */
async function municipioInicio(page, texto) {
  const { nome, uf } = municipioEUf(texto);
  if (!nome) return;
  // Pesquisa como foi digitado (em maiúsculas) e, sem resultado, sem acento.
  const comAcento = String(texto).split(/\s*[/\-–]\s*[A-Za-z]{2}$/)[0].trim().toUpperCase();
  for (const busca of [...new Set([comAcento, nome])]) {
    if (await escolherMunicipio(page, busca, nome, uf)) {
      // Igual ao setValues() da tela: depois da janelinha, a aba recarrega (VISUALIZAR).
      // Sem isso o SIARE vê a sequência fora de ordem e volta para a tela inicial.
      await acao(page, { url: SOL + '/NFAE/SERVICO_027', acaoSiare: 'VISUALIZAR', prova: '[name="dsMunicipioInicioTransp"]' });
      return;
    }
  }
  throw new Error(`Não achei o município de início do transporte "${texto}".`);
}

async function escolherMunicipio(page, busca, nome, uf) {
  const html = await buscarNaPagina(page, { abrir: SOL + '/NFAE/SELECAO_007?ACAO=VISUALIZAR', enviar: SOL + '/NFAE/SELECAO_007', campos: { nome: busca, ACAO: 'EXIBIRFLT' } });
  return page.evaluate((h, n, u) => {
    const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    const d = new DOMParser().parseFromString(h, 'text/html');
    const linhas = Array.from(d.querySelectorAll('input[name="ufw_selecao_registro"]')).map((i) => ({ id: i.id, nome: i.value, uf: i.getAttribute('descuf') }));
    const m = linhas.find((l) => sem(l.nome) === n && sem(l.uf) === u) || (linhas.length === 1 ? linhas[0] : null);
    if (!m) return false;
    const f = document.formTela;
    if (!f || !f.elements.idMunicipioInicioTransp) return false;
    f.elements.idMunicipioInicioTransp.value = m.id;
    f.elements.dsMunicipioInicioTransp.value = m.nome;
    return true;
  }, html, nome, uf);
}

/** Lê os totais da tela de conferência (Dados do Imposto). Melhor-esforço. */
async function lerPrevia(page) {
  const linhas = await page.evaluate(() => {
    const quero = ['Base Calc', 'Valor ICMS', 'Crédito Presumido', 'ICMS a Recolher', 'Total de Desconto', 'Total da NFA'];
    const out = [];
    for (const td of Array.from(document.querySelectorAll('td, th, label'))) {
      const rot = (td.textContent || '').replace(/\s+/g, ' ').trim();
      if (!quero.some((q) => rot.includes(q)) || rot.length > 60) continue;
      const prox = td.nextElementSibling;
      if (!prox) continue;
      // Campo de lista (ex.: alíquota do crédito presumido): vale o item escolhido.
      const sel = prox.querySelector('select');
      const campo = prox.querySelector('input[type="text"]');
      const val = (sel ? (sel.options[sel.selectedIndex] || {}).text || '' : campo ? campo.value : prox.textContent || '').replace(/\s+/g, ' ').trim();
      if (val && val.length <= 20 && /[\d,]/.test(val)) out.push([rot.replace(/:$/, ''), val]);
    }
    return out;
  }).catch(() => []);
  return linhas.length ? linhas : null;
}
