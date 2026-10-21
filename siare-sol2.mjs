// Cordas do SIARE (login do /sol) com os nomes dos campos CONFERIDOS na tela
// logada em 15/10/2026 (só leitura, sem enviar nada):
//   re.consultar      REGESPEC/CONSULTA_015          identificacao → EXIBIRFLT (DETALHE_037)
//   acesso.concessoes SEGURANC/CONCESSAO_ACESSO_USRRSP_MNT  dataInicial, dataFinal → EXIBIRFLT
//   acesso.relatorio  SEGURANC/SOLICITACAO_RELATORIO_ACESSO cpf, dataInicial, dataFinal → CONFNOVO
//   dae.manutencao    DAE/DAE_MNT                    protocolo | nossoNumero → EXIBIRFLT → PDF
//   consulta.sef      CONSCONT/CADASTRO_030 (desistência) numProPes → EXIBIRFLT; motivoDesistencia → CONFIRMAR
//   cerm.cadastrar    TFRM/CADASTRO_004              txtIdentificacaoResponsavel, txtProfissaoResponsavel,
//                                                    txtCREAResponsavel, txtReceitaBruta → CONFIRMAR
// Todo envio para antes e chama `pausar`. O retorno do envio (protocolo) ainda
// precisa ser conferido numa operação real.
import { acao, dormir, escolher, esperarCampo, radio, radioComRecarga, SOL, texto } from './siare-dom.mjs';
import { linhaPeloCep } from './siare-nfa.mjs';
import { BASE, baixarPdf, pedeLogin } from './navegador.mjs';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const dinheiro = (v) => Number(v || 0).toFixed(2).replace('.', ',');
/** Máscara do campo "Número do RE/PTA" (aplicaMascara da tela): 45.000012345-67. */
export const mascaraRE = (s) => digitos(s).slice(0, 13).replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{9})(\d)/, '$1-$2');

async function abrir(page, url, prova) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }).catch(() => null);
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await nav;
  if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a tela.');
  if (prova && !(await esperarCampo(page, prova, 20000))) throw new Error('A tela não abriu como esperado.');
}

/** Linhas de resultado das grades (tabelas com 2+ colunas), como texto curto. */
async function linhasDaGrade(page, max = 20) {
  return page.evaluate((m) => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr')) {
      const tds = [...tr.querySelectorAll('td')];
      if (tds.length < 2 || tr.querySelector('input[type="text"], select, textarea')) continue;
      const t = tds.map((td) => td.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
      if (t && t.length > 6 && t.length < 220) out.push(t);
      if (out.length >= m) break;
    }
    return out;
  }, max).catch(() => []);
}

async function lerAviso(page) {
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  return { txt, nenhum: /nenhum registro|0 registro|n[ãa]o (foi )?(localizad|encontrad)/i.test(txt) };
}

async function lerProtocolo(page) {
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  return (txt.match(/[Pp]rotocolo[:\s]*([\d.\-/]+)/) || [])[1] || '';
}

function exigirProtocolo(protocolo) {
  if (protocolo) return;
  const erro = new Error('O SIARE não devolveu o protocolo. Confira em "Acompanhar pedidos" antes de repetir.');
  erro.semProtocolo = true;
  throw erro;
}

// ---------------- re.consultar (leitura) ----------------
export async function consultarRegime({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  if (!e.numeroRE) throw new Error('Informe o número do RE ou PTA.');
  etapa('Abrindo a consulta de regimes especiais');
  await abrir(page, SOL + '/REGESPEC/CONSULTA_015?ACAO=VISUALIZAR', '[name="identificacao"]');
  await texto(page, 'identificacao', mascaraRE(e.numeroRE));
  etapa('Pesquisando');
  // O botão da tela posta em DETALHE_037?ACAO=EXIBIRFLT (com o ACAO na URL).
  await acao(page, { url: SOL + '/REGESPEC/DETALHE_037?ACAO=EXIBIRFLT', acaoSiare: 'EXIBIRFLT' });
  await dormir(1000);
  await evidencia('regime');
  const { txt, nenhum: vazio } = await lerAviso(page);
  // Número que não existe volta como "Erro de ambiente do Framework" (visto em 15/10/2026).
  const nenhum = vazio || /Erro de ambiente/i.test(txt);
  const itens = nenhum ? [] : await linhasDaGrade(page);
  const semRegime = /Erro de ambiente/i.test(txt) ? 'O SIARE não achou esse número. Confira o RE/PTA.' : 'Nenhum regime especial encontrado.';
  return { mensagem: nenhum ? semRegime : `${itens.length} linha(s) encontradas.`, itens };
}

// ---------------- acesso.concessoes (leitura) ----------------
export async function consultarConcessoes({ page, entradas, etapa, evidencia }) {
  const e = entradas || {};
  if (!e.inicio || !e.fim) throw new Error('Informe o período.');
  etapa('Abrindo o relatório de concessão de acesso');
  await abrir(page, SOL + '/SEGURANC/CONCESSAO_ACESSO_USRRSP_MNT?ACAO=VISUALIZAR', '[name="dataInicial"]');
  await texto(page, 'dataInicial', e.inicio, true);
  await texto(page, 'dataFinal', e.fim, true);
  etapa('Pesquisando');
  await acao(page, { url: SOL + '/SEGURANC/CONCESSAO_ACESSO_USRRSP_MNT', acaoSiare: 'EXIBIRFLT' });
  await dormir(1000);
  await evidencia('concessoes');
  const { nenhum } = await lerAviso(page);
  const itens = nenhum ? [] : await linhasDaGrade(page);
  return { mensagem: nenhum ? 'Ninguém recebeu acesso no período.' : `${itens.length} acesso(s) no período.`, itens };
}

// ---------------- acesso.relatorio (pedido) ----------------
export async function pedirRelatorioAcesso({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  if (!e.inicio || !e.fim) throw new Error('Informe o período.');
  etapa('Abrindo a solicitação de relatório de acesso');
  await abrir(page, SOL + '/SEGURANC/SOLICITACAO_RELATORIO_ACESSO?ACAO=NOVO', '[name="dataInicial"]');
  // O CPF é só leitura (vem da lupa) e não é obrigatório: sem ele, o relatório é de todos.
  const cpfEditavel = await page.evaluate(() => { const c = document.querySelector('[name="cpf"]'); return !!(c && !c.readOnly && !c.disabled); }).catch(() => false);
  if (e.cpf && cpfEditavel) await texto(page, 'cpf', digitos(e.cpf));
  await texto(page, 'dataInicial', e.inicio, true);
  await texto(page, 'dataFinal', e.fim, true);
  await evidencia('relatorio-acesso-preenchido');
  await pausar([['CPF', e.cpf && cpfEditavel ? digitos(e.cpf) : 'todos (o SIARE só aceita CPF pela lupa)'], ['Período', `${e.inicio} a ${e.fim}`]]);
  etapa('Pedindo o relatório');
  await acao(page, { url: SOL + '/SEGURANC/SOLICITACAO_RELATORIO_ACESSO', acaoSiare: 'CONFNOVO', valida: true });
  await dormir(1500);
  await evidencia('relatorio-acesso-resultado');
  const protocolo = await lerProtocolo(page);
  // O relatório vai para a fila da aba "Relatório"; nem sempre há protocolo na tela.
  // Sem protocolo, só vale como feito se a tela disser que deu certo.
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const ok = /sucesso|realizad[ao]|registrad[ao]|solicita[çc][ãa]o (foi )?(efetuad|enviad|inclu)/i.test(txt);
  if (!protocolo && !ok) exigirProtocolo('');
  return { ...(protocolo ? { protocolo } : { confirmado: true }), mensagem: 'Relatório pedido. Ele aparece na aba "Relatório" do SIARE quando ficar pronto.' };
}

// ---------------- dae.manutencao (só "visualizar") ----------------
export async function manutencaoDae({ page, entradas, etapa, evidencia, guardarArquivo }) {
  const e = entradas || {};
  if (e.acao === 'substituir') throw new Error('Substituir DAE ainda não é feito por aqui. Use o SIARE direto.');
  if (!e.protocolo && !e.numeroDAE) throw new Error('Informe o protocolo ou o número do DAE.');
  etapa('Abrindo a manutenção de DAE');
  await abrir(page, SOL + '/DAE/DAE_MNT?ACAO=VISUALIZAR', '[name="protocolo"], [name="nossoNumero"]');
  if (e.protocolo) await texto(page, 'protocolo', digitos(e.protocolo));
  if (e.numeroDAE) await texto(page, 'nossoNumero', digitos(e.numeroDAE));
  etapa('Pesquisando');
  await acao(page, { url: SOL + '/DAE/DAE_MNT', acaoSiare: 'EXIBIRFLT' });
  await dormir(1000);
  const { nenhum } = await lerAviso(page);
  if (nenhum) { await evidencia('dae-mnt'); return { mensagem: 'DAE não encontrado.' }; }
  // Marca a primeira linha e pede a impressão (PDF).
  await page.evaluate(() => {
    const c = document.querySelector('table input[type="checkbox"]:not([name="chkSelecaoTodos"]), table input[type="radio"]');
    if (c) { c.checked = true; c.dispatchEvent(new Event('click', { bubbles: true })); }
  }).catch(() => undefined);
  const pdf = (await baixarPdf(page, BASE + '/arrecadacao/ctrl/ARRECADA/ARRECADA/VISUALIZAR_IMPRIMIR?visualizacao=sol-mnt&ACAO=VISUALIZAR&formato=PDF')).pdf;
  await evidencia('dae-mnt');
  if (!pdf) return { mensagem: 'DAE encontrado (veja a evidência).', itens: await linhasDaGrade(page) };
  const url = await guardarArquivo('dae-manutencao.pdf', pdf);
  return { mensagem: 'DAE encontrado.', pdfs: [{ nome: 'DAE', url }] };
}
manutencaoDae.somenteLeitura = true; // o ramo "substituir" é recusado antes de tudo

// ---------------- consulta.sef (só desistência) ----------------
// Formular Consulta (CONSCONT/CADASTRO_021 a 027, lido em 15/10/2026): Identificação
// (já vem preenchida) → Informações Compl. (outros tributos: ICMS ST/IPVA; isenção
// da taxa) → REs em Vigor → Ação Fiscal → Comprovação de Saídas (ECF, PED, NF-e) →
// Solicitação (o arquivo da consulta: CADASTRO_009 tipoArquivo=1; complementares,
// tipoArquivo=2) → Envio ("Confirma o envio de sua Consulta?" CONFIRMAR).
const tf = (v) => (v === true || v === 'true' ? 'true' : 'false');

async function anexarConsulta(page, { tipoArquivo, arquivo, descricao }) {
  const url = `${SOL}/CONSCONT/CADASTRO_009?nomeModelRetorno=modelRetorno${tipoArquivo}&telaRetorno=CADASTRO_026&nomeTxtModel=txtModel&tipoArquivo=${tipoArquivo}&acaoRetorno=VISUALIZAR&modelGrid=ufw_selecao_registro${tipoArquivo}`;
  await acao(page, { url, acaoSiare: 'NOVO', valida: false, prova: '[name="nomeFile"]' });
  const campo = await page.$('input[name="nomeFile"]');
  await campo.uploadFile(arquivo.caminho);
  await texto(page, 'descricao', String(descricao || arquivo.nome).slice(0, 50));
  await acao(page, { url: SOL + '/CONSCONT/CADASTRO_009', acaoSiare: 'CONFNOVO', valida: true, prova: '[name="ufw_selecao_registro_todos_gridDocumentosComplementares"]' });
  // A tela diz "Documento incluído com sucesso" e mostra a descrição com o "Hashing" do arquivo.
  const desc = String(descricao || arquivo.nome).slice(0, 20);
  return page.evaluate((d) => {
    const t = (document.body && document.body.innerText) || '';
    return /inclu[íi]do com sucesso/i.test(t) || t.includes(d);
  }, desc).catch(() => false);
}

async function formularConsulta({ page, entradas, etapa, evidencia, pausar, anexo }) {
  const e = entradas || {};
  if (e.reEmVigor === true || e.reEmVigor === 'true' || e.acaoFiscal === true || e.acaoFiscal === 'true') {
    throw new Error('Com regime especial em vigor ou ação fiscal, a consulta pede dados extras: use o SIARE. Nada foi feito.');
  }
  const principal = anexo && anexo(String(e.arquivo || '').split('|')[0]);
  if (!principal) throw new Error('Anexe o arquivo da consulta.');
  if (!String(e.assunto || '').trim()) throw new Error('Informe o assunto da consulta.');
  const complementar = e.complementar ? anexo(String(e.complementar).split('|')[0]) : null;
  // Cada aba tem o próprio "valida" no link (024→025 é sem validação): usa o da tela.
  const aba = async (n, prova) => {
    const ler = () => page.evaluate((alvo) => {
      const s = Array.from(document.querySelectorAll('[onclick]')).map((el) => el.getAttribute('onclick')).find((x) => x.includes(alvo + "','VISUALIZAR'")) || '';
      const m = s.match(/genericOnClick\(document\.formTela,(true|false),'([^']+)'/);
      return m ? { valida: m[1] === 'true', url: m[2] } : null;
    }, '/CONSCONT/CADASTRO_0' + n);
    // A tela pode estar recarregando por causa de um rádio: espera e lê de novo.
    let link = null;
    for (let t = 0; t < 3 && !link; t++) {
      link = await ler().catch(async () => { await page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => null); await dormir(500); return null; });
    }
    await acao(page, { url: link ? 'https://www2.fazenda.mg.gov.br' + link.url : SOL + '/CONSCONT/CADASTRO_0' + n, acaoSiare: 'VISUALIZAR', valida: link ? link.valida : false, prova });
  };

  etapa('Abrindo a consulta');
  await abrir(page, SOL + '/CONSCONT/CADASTRO_021?ACAO=VISUALIZAR', '[name="solicitante.inscEstadualFormatada"], [name="solicitante.identificacaoFormatada"]');
  etapa('Informações complementares');
  await acao(page, { url: SOL + '/CONSCONT/CADASTRO_022', acaoSiare: 'VISUALIZAR', valida: false, prova: '[name="outrosTributos"]' });
  const outros = !!(e.icmsST === true || e.icmsST === 'true' || e.ipva === true || e.ipva === 'true');
  await radioComRecarga(page, 'outrosTributos', outros ? 'true' : 'false', '[name="outrosTributos"]', 4000);
  await dormir(500);
  if (outros) {
    await page.evaluate((st, ipva) => {
      for (const cb of document.querySelectorAll('input[name="ufw_selecao_registro"]')) {
        const t = ((cb.closest('tr') || {}).textContent || '').toUpperCase();
        if ((st && /SUBSTITUI/.test(t)) || (ipva && /IPVA/.test(t))) { if (!cb.checked) cb.click(); }
      }
    }, e.icmsST === true || e.icmsST === 'true', e.ipva === true || e.ipva === 'true');
  }
  await radioComRecarga(page, 'isencaoTaxa', tf(e.isencaoTaxa), '[name="isencaoTaxa"]', 4000);
  etapa('Regime especial e ação fiscal');
  await aba('23', '[name="reEmVigorMesmaMateriaMG"]');
  await radioComRecarga(page, 'reEmVigorMesmaMateriaMG', 'false', '[name="reEmVigorMesmaMateriaMG"]', 4000);
  await aba('24', '[name="ptaEstabAcaoFiscal"]');
  await radioComRecarga(page, 'ptaEstabAcaoFiscal', 'false', '[name="ptaEstabAcaoFiscal"]', 4000);
  etapa('Comprovação de saídas');
  await aba('25', '[name="dispensadoComprovadoSaidas"]');
  // Nesta aba o clique de um rádio recarrega a tela (visto em 15/10/2026): espera a recarga.
  const naAba25 = '[name="dispensadoComprovadoSaidas"]';
  await radioComRecarga(page, 'dispensadoComprovadoSaidas', tf(e.dispensadoSaidas), naAba25, 4000);
  await radioComRecarga(page, 'utilizaECF', tf(e.usaECF), naAba25, 4000);
  await radioComRecarga(page, 'utilizaPED', tf(e.usaPED), naAba25, 4000);
  await radioComRecarga(page, 'utilizaNF', tf(e.usaNFe), naAba25, 4000);
  etapa('Arquivo da consulta');
  await aba('26', '[name="ufw_selecao_registro_todos_gridDocumentosComplementares"]');
  if (!(await anexarConsulta(page, { tipoArquivo: 1, arquivo: principal, descricao: e.assunto }))) throw new Error('O SIARE não mostrou o arquivo da consulta depois de anexar.');
  if (complementar) await anexarConsulta(page, { tipoArquivo: 2, arquivo: complementar, descricao: 'Documento complementar' });
  etapa('Envio');
  await aba('27', null);
  await evidencia('consulta-pronta');
  await pausar([['Assunto', String(e.assunto).slice(0, 50)], ['Arquivo', principal.nome], ...(complementar ? [['Complementar', complementar.nome]] : []), ['Isenção da taxa', tf(e.isencaoTaxa) === 'true' ? 'Sim' : 'Não']]);
  etapa('Enviando a consulta');
  await acao(page, { url: SOL + '/CONSCONT/CADASTRO_027', acaoSiare: 'CONFIRMAR', valida: false });
  await dormir(1500);
  const protocolo = await lerProtocolo(page);
  await evidencia('consulta-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: 'Consulta enviada à Fazenda.' };
}

export async function consultaFazenda(args) {
  const { page, entradas, etapa, evidencia, pausar } = args;
  const e = entradas || {};
  if (e.tipo === 'formular') return formularConsulta(args);
  if (e.tipo !== 'desistencia') {
    throw new Error('Recurso e retificação partem de uma consulta já aberta: use o SIARE direto.');
  }
  if (!e.protocolo || !e.texto) throw new Error('Informe o protocolo e o motivo.');
  etapa('Abrindo a desistência de consulta');
  await abrir(page, SOL + '/CONSCONT/CADASTRO_030?ACAO=VISUALIZAR', '[name="numProPes"]');
  await texto(page, 'numProPes', digitos(e.protocolo));
  etapa('Procurando a consulta');
  await acao(page, { url: SOL + '/CONSCONT/CADASTRO_030', acaoSiare: 'EXIBIRFLT' });
  await dormir(800);
  const avisoSef = await page.evaluate(() => { const l = ((document.body && document.body.innerText) || '').split(/\r?\n/).map((x) => x.trim()).find((x) => /protocolo inv[áa]lido|n[ãa]o (foi )?(encontrad|localizad)|inv[áa]lid/i.test(x) && x.length < 160); return l || ''; }).catch(() => '');
  if (avisoSef) throw new Error('O SIARE recusou: ' + avisoSef);
  await texto(page, 'motivoDesistencia', e.texto);
  await evidencia('desistencia-preenchida');
  await pausar([['Protocolo da consulta', digitos(e.protocolo)], ['Motivo', String(e.texto).slice(0, 80)]]);
  etapa('Enviando a desistência');
  await acao(page, { url: SOL + '/CONSCONT/CADASTRO_030', acaoSiare: 'CONFIRMAR', valida: true });
  await dormir(1500);
  const protocolo = await lerProtocolo(page);
  await evidencia('desistencia-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: 'Desistência enviada.' };
}

// ---------------- cerm.cadastrar (passo 1) ----------------
export async function cadastrarCerm({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  if (!e.cpf || !e.profissao || !e.crea || e.receitaBruta == null) throw new Error('Falta CPF, profissão, CREA ou receita.');
  etapa('Abrindo o cadastro CERM');
  await abrir(page, SOL + '/TFRM/CADASTRO_004?ACAO=VISUALIZAR', '[name="txtIdentificacaoResponsavel"]');
  await texto(page, 'txtIdentificacaoResponsavel', digitos(e.cpf));
  await texto(page, 'txtProfissaoResponsavel', e.profissao);
  // A tela tem um campo só "CREA/UF".
  await texto(page, 'txtCREAResponsavel', e.ufCrea ? `${e.crea}/${e.ufCrea}` : e.crea);
  await texto(page, 'txtReceitaBruta', dinheiro(e.receitaBruta));
  await evidencia('cerm-preenchido');
  await pausar([['CPF', digitos(e.cpf)], ['Profissão', e.profissao], ['CREA/UF', e.ufCrea ? `${e.crea}/${e.ufCrea}` : e.crea], ['Receita bruta', 'R$ ' + dinheiro(e.receitaBruta)]]);
  etapa('Enviando o cadastro');
  await acao(page, { url: SOL + '/TFRM/CADASTRO_004', acaoSiare: 'CONFIRMAR', valida: true });
  await dormir(1500);
  const protocolo = await lerProtocolo(page);
  await evidencia('cerm-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: 'Cadastro CERM (passo 1) enviado.' };
}

// ---------------- acesso.delegar (dar acesso a um operador) ----------------
// Controle de Acesso → Usuário Substabelecido (SEGURANC/USUARIO_SUBSTABELECIDO_CAD),
// lido na tela em 15/10/2026: CPF (o blur chama buscarDadosAJAX, que traz nome,
// e-mail, telefone e endereço da pessoa cadastrada no SIARE), Data de Expiração
// (limiteAtividade), Perfil (USU_MAPR, única opção) e endereço pela janelinha do
// CEP (funcaoRetorno=recebeValores). É o caminho oficial para um operador entrar
// com a própria senha na IE do produtor ("Operador com acesso delegado" no app).
/** CPFs (só dígitos) que já têm acesso substabelecido: abre a lista e pesquisa. */
async function cpfsComAcesso(page) {
  await abrir(page, SOL + '/SEGURANC/USUARIO_SUBSTABELECIDO_MNT?ACAO=VISUALIZAR', '[name="numCpf"]');
  await page.evaluate(() => { if (document.formTela && document.formTela.ufw_posicao) document.formTela.ufw_posicao.value = 1; }).catch(() => undefined);
  await acao(page, { url: SOL + '/SEGURANC/USUARIO_SUBSTABELECIDO_MNT', acaoSiare: 'EXIBIRFLT', valida: true }).catch(() => undefined);
  return page.evaluate(() => Array.from(document.querySelectorAll('input[name="ufw_selecao_registro"]')).map((x) => ((x.closest('tr') || {}).textContent || '').replace(/\D/g, ''))).catch(() => []);
}

export async function darAcesso({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  const cpf = digitos(e.cpf);
  if (cpf.length !== 11) throw new Error('Informe o CPF de quem vai receber o acesso.');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(e.expiracao || ''))) throw new Error('Informe até quando vale o acesso.');
  etapa('Abrindo os usuários substabelecidos');
  if ((await cpfsComAcesso(page)).some((d) => d.includes(cpf))) throw new Error('Esse CPF já tem acesso a esta IE. Nada foi feito.');
  await abrir(page, SOL + '/SEGURANC/USUARIO_SUBSTABELECIDO_MNT?ACAO=VISUALIZAR', '[name="numCpf"]');
  await acao(page, { url: SOL + '/SEGURANC/USUARIO_SUBSTABELECIDO_CAD', acaoSiare: 'NOVO', valida: false });
  if (!(await esperarCampo(page, '[name="cpf"]'))) throw new Error('A tela de novo acesso não abriu.');
  etapa('CPF de quem recebe o acesso');
  await page.evaluate((v) => {
    const c = document.querySelector('[name="cpf"]');
    c.value = v;
    c.dispatchEvent(new Event('change', { bubbles: true }));
    c.dispatchEvent(new Event('blur', { bubbles: true }));
  }, cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'));
  // O AJAX abre e-mail e telefone; o nome aparece ao lado do rótulo "Nome:".
  let nome = '';
  for (const ate = Date.now() + 12000; Date.now() < ate; ) {
    await dormir(800);
    const r = await page.evaluate(() => {
      const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const tds = Array.from(document.querySelectorAll('td'));
      const i = tds.findIndex((td) => /^Nome:?$/i.test(limpa(td.textContent)));
      return { nome: i >= 0 && tds[i + 1] ? limpa(tds[i + 1].textContent) : '', email: !!document.querySelector('input[name="email"]') };
    }).catch(() => ({ nome: '', email: false }));
    nome = r.nome;
    if (nome || r.email) break;
  }
  await texto(page, 'limiteAtividade', e.expiracao, true);
  if (e.email) await texto(page, 'email', e.email);
  if (e.telefone) await texto(page, 'comunicacao.telefone', digitos(e.telefone));
  if ((await escolher(page, 'perfil', 'USU_MAPR')) !== 'USU_MAPR') throw new Error('O SIARE não aceitou o perfil de acesso.');
  // Endereço: o AJAX traz o da pessoa cadastrada; sem ele, pelo CEP do app.
  const temEndereco = await page.evaluate(() => Number((document.querySelector('[name="endereco.idMunicipio"]') || {}).value || 0) > 0).catch(() => false);
  if (!temEndereco) {
    if (!e.cep) throw new Error('O SIARE não trouxe o endereço dessa pessoa. Informe o CEP, o endereço e o bairro.');
    etapa('Endereço pelo CEP');
    const linha = await linhaPeloCep(page, e, `${SOL}/RETAGUAR/ENDERECO_INTERNET_PSQ?getDadosEnd=opener.getDadosEnd&ACAO=VISUALIZAR&funcaoRetorno=opener.recebeValores`, 'quem recebe o acesso');
    const ok = await page.evaluate((l) => { if (typeof window.recebeValores !== 'function') return false; window.recebeValores(l); return true; }, linha).catch(() => false);
    if (!ok) throw new Error('Não consegui pôr o endereço na tela.');
  }
  await evidencia('dar-acesso-preenchido');
  const previa = [['Quem recebe o acesso', nome || 'o SIARE não trouxe o nome: confira o CPF'], ['CPF', cpf], ['Até', e.expiracao], ['Perfil', 'Usuário Master de IE PR']];
  if (!nome) previa.push(['Atenção', 'O CPF precisa ter cadastro no SIARE para receber acesso.']);
  await pausar(previa);
  etapa('Dando o acesso');
  await acao(page, { url: SOL + '/SEGURANC/USUARIO_SUBSTABELECIDO_CAD', acaoSiare: 'CONFNOVO', valida: true });
  await dormir(1500);
  await evidencia('dar-acesso-resultado');
  // Confere na lista: o CPF tem de aparecer entre os substabelecidos.
  const entrou = (await cpfsComAcesso(page)).some((d) => d.includes(cpf));
  await evidencia('dar-acesso-lista');
  if (!entrou) {
    const erro = new Error('O SIARE não mostrou o novo acesso na lista. Confira em Controle de Acesso antes de repetir.');
    erro.semProtocolo = true;
    throw erro;
  }
  return { confirmado: true, mensagem: `Acesso dado${nome ? ' a ' + nome : ''} até ${e.expiracao}.` };
}
