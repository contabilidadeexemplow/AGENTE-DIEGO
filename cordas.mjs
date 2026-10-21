// As cordas reais do servidor. Por enquanto só as que LEEM: nenhuma delas
// clica em confirmar, finalizar ou excluir. Cada uma recebe a página já logada
// e devolve o resultado no formato do CONTRATO-API.md.
//
// Corda que chega a um passo sem volta (risco "pedido" ou "irreversivel") DEVE
// chamar  await pausar(previa)  antes dele: o pedido fica "aguardando
// confirmação" e só segue depois do /confirmar da pessoa. Sem protocolo no
// fim, o pedido vai para "verificar" (nunca é repetido sozinho).
import { BASE, baixarPdf, dormir, pedeLogin } from './navegador.mjs';
import { emitirNfa } from './siare-nfa.mjs';
import { alterarCadastro, novaPropriedade } from './siare-pr.mjs';
import { autorizarNfaOffline, cancelarNfa, cancelarSaida, registrarSaida, reimprimirNfa } from './siare-mais.mjs';
import { certificarDocumento, comprovanteDae, consultarDae, emitirDae, reemitirDae } from './siare-dae.mjs';
import { cadastrarCerm, consultaFazenda, consultarConcessoes, consultarRegime, darAcesso, manutencaoDae, pedirRelatorioAcesso } from './siare-sol2.mjs';
import { autorizarEmissor, pesquisarEpta, procuradoresDte } from './siare-jsf.mjs';

const limpa = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

async function esperarTexto(page, texto, tetoMs = 30000) {
  const ate = Date.now() + tetoMs;
  while (Date.now() < ate) {
    const t = await page.evaluate(() => (document.readyState === 'complete' && document.body && document.body.innerText) || '').catch(() => '');
    if (t.includes(texto)) { await dormir(800); return true; }
    await dormir(400);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Consulta cadastral do produtor: porte direto do robo-campo
// (robo-campo/src/consultas/cadastro-do-produtor.ts, conferido na tela em 14/10/2026).
// ---------------------------------------------------------------------------

const CAMINHO_CONSULTA = '/sol/ctrl/SOL/PRURAL/SERVICO_035?ACAO=VISUALIZAR&APLICACAO=SOL&MODULO=PRURAL&SIGLA=CONSULTA_050&ACAO_TELA=VISUALIZAR';
const ABAS = [
  { aba: 'Atividade', link: 'Atividade Rural', prova: 'Data de Início de Atividade' },
  { aba: 'Estabelecimento', link: 'Estabelecimento/Propriedade Rural', prova: 'Nome do Estabelecimento ou Propriedade Rural' },
  { aba: 'Endereço', link: 'Endereço/Contato', prova: 'Referência de Localização' },
];

// Rótulo numa célula, valor na seguinte. Rótulo termina em ":" ou, nas
// perguntas, em "?" (a versão que só aceitava ":" perdia duas perguntas).
function lerPares(page) {
  return page.evaluate(() => {
    const limpa = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const form = document.formTela || document.body;
    const saida = [];
    for (const td of form.querySelectorAll('td')) {
      const rotulo = limpa(td.textContent);
      if (!/[:?]\s*$/.test(rotulo) || rotulo.length > 80 || td.querySelector('table')) continue;
      const prox = td.nextElementSibling;
      saida.push({ rotulo, valor: limpa(prox ? prox.textContent : '') });
    }
    return saida;
  });
}

async function abrirAbaPorLink(page, texto) {
  const navegando = page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => null);
  const clicou = await page.evaluate((t) => {
    const a = Array.from(document.querySelectorAll('a')).find((x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === t);
    if (!a) return false;
    a.click();
    return true;
  }, texto);
  if (clicou) await navegando;
  return clicou;
}

async function consultarCadastro({ page, etapa, evidencia }) {
  etapa('Abrindo Consultar Dados da Inscrição Estadual');
  await page.goto(BASE + CAMINHO_CONSULTA, { waitUntil: 'load', timeout: 90000 });
  const itens = [];
  const dados = {};
  for (const [i, aba] of ABAS.entries()) {
    etapa('Lendo a aba ' + aba.link);
    if (i > 0) await abrirAbaPorLink(page, aba.link);
    if (!(await esperarTexto(page, aba.prova))) {
      await evidencia('aba-nao-abriu');
      if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu: o portal voltou a pedir login.');
      throw new Error(`A aba "${aba.link}" não abriu. A tela pode ter mudado.`);
    }
    await evidencia(aba.aba);
    const pares = await lerPares(page);
    dados[aba.aba] = pares;
    // A aba Endereço repete os rótulos: o 2º bloco é o de correspondência.
    const vistos = new Set();
    for (const p of pares) {
      const repetido = vistos.has(p.rotulo);
      vistos.add(p.rotulo);
      const valor = p.valor && p.valor !== '-' ? p.valor : '—';
      itens.push(`${aba.aba}${repetido ? ' (correspondência)' : ''} · ${p.rotulo.replace(/[:]\s*$/, '')} ${valor}`);
    }
    await dormir(600); // cada troca de aba é um POST; atropelar dá "Ação inválida"
  }
  const situacao = (dados.Atividade || []).find((p) => /^situa/i.test(p.rotulo));
  return {
    mensagem: situacao ? `Situação da IE: ${situacao.valor}` : 'Cadastro lido.',
    itens,
    dados,
  };
}

// ---------------------------------------------------------------------------
// Comprovante de inscrição: a tela devolve o PDF direto (só leitura).
// ---------------------------------------------------------------------------

async function comprovanteInscricao({ etapa, page, guardarArquivo, evidencia }) {
  etapa('Pedindo o PDF do comprovante de inscrição');
  const url = BASE + '/sol/ctrl/SOL/PRURAL/SERVICO_035?ACAO=VISUALIZAR&SIGLA=SERVICO_036&MODULO=PRURAL&ACAO_TELA=VISUALIZAR&APLICACAO=SOL';
  const r = await baixarPdf(page, url);
  if (!r.pdf) {
    await evidencia('sem-pdf');
    throw new Error('O SIARE não devolveu um PDF. Início da resposta: ' + limpa(r.html).slice(0, 200));
  }
  const link = await guardarArquivo('comprovante-de-inscricao.pdf', r.pdf);
  return { mensagem: 'Comprovante baixado.', pdfs: [{ nome: 'Comprovante da IE', url: link }] };
}

// ---------------------------------------------------------------------------
// Acompanhar pedidos: grade "Serviços Solicitados" da página inicial logada.
// ---------------------------------------------------------------------------

async function acompanharPedidos({ page, entradas, etapa, evidencia }) {
  // "Serviços Solicitados" abre pelo ícone de ferramenta do topo (SERVICO_SOLICITANTE).
  // Por URL direta o SIARE responde "Requisição Inválida", e a página inicial não
  // tem o ícone: abre uma tela interna só de leitura (Imprimir NFA) e clica nele
  // (visto em 15/10/2026).
  etapa('Abrindo Serviços Solicitados');
  await page.goto(BASE + '/sol/ctrl/SOL/NFAE/SERVICO_068?ACAO=VISUALIZAR', { waitUntil: 'load', timeout: 90000 });
  if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu. Entre de novo.');
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => null);
  const clicou = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[onclick]')).find((x) => /SERVICO_SOLICITANTE/.test(x.getAttribute('onclick') || ''));
    if (a) setTimeout(() => a.click(), 0);
    return !!a;
  }).catch(() => false);
  if (!clicou) throw new Error('Não achei o atalho "Serviços Solicitados" no topo do SIARE.');
  await nav;
  // O clique volta à página inicial, onde fica a grade. Por cima dela o SIARE pode
  // abrir uma janela própria (ex.: Termo de Adesão ao DT-e): não se mexe nela, só
  // se lê a grade de trás. Procura em todos os quadros: cabeçalho com "Protocolo" e
  // "Fase"; as linhas são as de seleção (ufw_selecao_registro) ou as que seguem o cabeçalho.
  const lerGrade = () => {
    const limpa = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    if (document.readyState !== 'complete') return null;
    // Uma célula pode trazer duas colunas separadas por <p></p> ("Data Início" / "Fase"
    // e "10/02/2022" / "Indeferido", visto em 15/10/2026): cada linha do texto vira uma coluna.
    const celulas = (tr) => Array.from(tr.cells).flatMap((c) => {
      const partes = String(c.innerText || '').split(/\n+/).map(limpa).filter(Boolean);
      return partes.length ? partes : [''];
    });
    const cabTr = Array.from(document.querySelectorAll('tr')).find((tr) => !tr.querySelector('tr') && celulas(tr).some((c) => /^protocolo$/i.test(c)) && celulas(tr).some((c) => /^fase$/i.test(c)));
    if (!cabTr) return null;
    const tabela = cabTr.closest('table');
    const marcadas = Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((i) => i.closest('tr')).filter(Boolean);
    const linhas = marcadas.length ? marcadas : Array.from(tabela.rows).slice(Array.from(tabela.rows).indexOf(cabTr) + 1);
    return { cab: celulas(cabTr), dados: linhas.map(celulas).filter((r) => r.some(Boolean)) };
  };
  let linhas = null;
  for (const ate = Date.now() + 45000; Date.now() < ate && !linhas; ) {
    for (const quadro of page.frames()) {
      // Quadro que some no meio da troca de tela lança erro na hora (não só rejeita).
      let r = null;
      try { r = await quadro.evaluate(lerGrade); } catch { /* tenta de novo */ }
      if (r && r.cab) { linhas = r; break; }
    }
    if (!linhas) await dormir(1000);
  }
  await evidencia('servicos-solicitados');
  if (!linhas) throw new Error('Não achei a grade "Serviços Solicitados". A tela pode ter mudado; veja a evidência.');
  const so = String(entradas.protocolo || '').replace(/\D/g, '');
  const filtradas = so ? linhas.dados.filter((r) => r.some((c) => c.replace(/\D/g, '') === so)) : linhas.dados;
  return {
    mensagem: filtradas.length ? `${filtradas.length} pedido(s).` : 'Nenhum pedido encontrado.',
    itens: filtradas.map((r) => linhas.cab.map((c, i) => (c ? c + ': ' : '') + (r[i] || '')).filter((x) => x.replace(/[: ]/g, '')).join(' · ')),
    dados: linhas,
  };
}

// ---------------------------------------------------------------------------
// Consultar NCM (CONSULTA_119). Os nomes dos campos não foram anotados no
// mapa: a corda acha o campo pelo rótulo da linha e pesquisa (EXIBIRFLT).
// Primeira execução real deve ser conferida pela evidência.
// ---------------------------------------------------------------------------

async function consultarNcm({ page, entradas, etapa, evidencia }) {
  etapa('Abrindo Consultar NCM');
  await page.goto(BASE + '/sol/ctrl/SOL/NFAE/CONSULTA_119?ACAO=VISUALIZAR', { waitUntil: 'load', timeout: 90000 });
  await dormir(800);
  etapa('Pesquisando');
  const ok = await page.evaluate((por, valor, modo) => {
    const limpa = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const campoDaLinha = (re) => {
      for (const td of document.querySelectorAll('td')) {
        if (!re.test(limpa(td.textContent)) || td.querySelector('table')) continue;
        const alvo = td.nextElementSibling && td.nextElementSibling.querySelector('input[type=text], input:not([type])');
        if (alvo) return alvo;
      }
      return null;
    };
    const campo = por === 'codigo' ? campoDaLinha(/^c[óo]digo/i) : campoDaLinha(/^descri/i);
    if (!campo) return 'sem-campo';
    campo.value = valor;
    if (por !== 'codigo') {
      const r = Array.from(document.querySelectorAll('input[type=radio]')).find((x) => x.value === modo);
      if (r) r.click();
    }
    const botao = Array.from(document.querySelectorAll('a[onclick]')).find((a) => /EXIBIRFLT/.test(a.getAttribute('onclick')));
    if (!botao) return 'sem-botao';
    botao.click();
    return 'ok';
  }, entradas.por, entradas.por === 'codigo' ? String(entradas.codigo).replace(/^0+/, '') : entradas.descricao, String(entradas.modo || '1'));
  if (ok !== 'ok') { await evidencia('ncm-' + ok); throw new Error('A tela do Consultar NCM não tem o campo ou o botão esperado (' + ok + ').'); }
  await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => null);
  await dormir(800);
  await evidencia('resultado-ncm');
  const itens = await page.evaluate(() => {
    const limpa = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('tr'))
      .map((r) => limpa(r.textContent))
      .filter((t) => /^\d{6,8}\s*[-–]/.test(t) || /^\d{6,8}\s+\S/.test(t))
      .slice(0, 50);
  });
  return { mensagem: itens.length ? `${itens.length} resultado(s).` : 'Nenhum resultado. Por código, o SIARE só acha o código completo, sem o zero da frente.', itens };
}

// processo do catálogo → corda. Só as que já LEEM ficam ligadas.
export const CORDAS = {
  'pr.consultar': consultarCadastro,
  'pr.comprovante': comprovanteInscricao,
  'nfa.acompanhar': acompanharPedidos,
  'ncm.consultar': consultarNcm,
};

// Cordas que ESCREVEM ou pedem algo à Fazenda. Conferidas no SIARE real em
// 15/10/2026 (NFA emitida e cancelada de verdade; as demais até a pausa). Toda
// uma para antes do passo sem volta e só segue com o "Confirmar" da pessoa no app.
// Entram em CORDAS por padrão; SO_CONSULTAS=1 deixa o servidor só com as consultas.
export const CORDAS_EM_TESTE = {
  'nfa.emitir': emitirNfa,
  'pr.alteracao': alterarCadastro,
  'nfa.cancelar': cancelarNfa,
  'nfa.imprimir': reimprimirNfa,
  'nfa.offline': autorizarNfaOffline,
  'saida.registrar': registrarSaida,
  'saida.cancelar': cancelarSaida,
  'dae.consultar': consultarDae,
  'dae.comprovante': comprovanteDae,
  'dae.reemitir': reemitirDae,
  'dae.emitir': emitirDae,
  'doc.certificar': certificarDocumento,
  're.consultar': consultarRegime,
  'acesso.concessoes': consultarConcessoes,
  'acesso.relatorio': pedirRelatorioAcesso,
  'dae.manutencao': manutencaoDae,
  'consulta.sef': consultaFazenda,
  'cerm.cadastrar': cadastrarCerm,
  'acesso.delegar': darAcesso,
  'pr.autorizarEmissor': autorizarEmissor,
  'pr.estabelecimento': novaPropriedade,
  'dte.procurador': procuradoresDte,
  'epta.pesquisar': pesquisarEpta,
};
if (process.env.SO_CONSULTAS !== '1') Object.assign(CORDAS, CORDAS_EM_TESTE);

// O que ainda não tem corda real aqui, e por quê.
export function motivoSemCorda(processo) {
  return 'Esta função chega em breve: ainda não é executada no SIARE. Nada foi feito.';
}
