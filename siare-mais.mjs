// Mais cordas do SIARE (login do /sol), escritas a partir do GUIA-SIARE:
//   nfa.imprimir  — reimprimir NFA (só leitura, baixa o PDF)   §2.2 SERVICO_068
//   nfa.cancelar  — pedir cancelamento de NFA (irreversível)   §2.3 SERVICO_011
//   nfa.offline   — pedir autorização para NFA offline         §2.4 SERVICO_185
//   saida.registrar — registrar saída de NF-e                  §4   MONITDOC/SERVICO_001
//   saida.cancelar  — cancelar registro de saída (irreversível)§4   MONITDOC/SERVICO_003
//
// A página chega já logada. Toda função com passo sem volta chama `pausar`.
// Nomes dos campos CONFERIDOS na tela logada em 15/10/2026 (leitura, sem enviar).
// Falta conferir o retorno do envio (protocolo, grade) numa operação real.
import { acao, acaoDoBotao, botaoDaTela, dormir, escolher, esperarCampo, radio, selecionar, selecionarPorDigitos, SOL, texto } from './siare-dom.mjs';
import { baixarPdf, pedeLogin } from './navegador.mjs';
import { danfePelaTela } from './siare-nfa.mjs';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

async function abrir(page, url, prova) {
  const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 90000 }).catch(() => null);
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await nav;
  if (await pedeLogin(page)) throw new Error('A sessão do SIARE caiu ao abrir a tela.');
  if (prova && !(await esperarCampo(page, prova))) throw new Error('A tela não abriu como esperado.');
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

// ---------------- nfa.imprimir (só leitura) ----------------
export async function reimprimirNfa({ page, entradas, etapa, evidencia, guardarArquivo }) {
  const e = entradas || {};
  if (!digitos(e.identificacao)) throw new Error('Informe o protocolo ou o número da NFA.');
  // Mesmo caminho testado em 15/10/2026 (NFA-e 053.510.911): tipo 1 = protocolo, 0 = número.
  etapa('Gerando o PDF da nota');
  const info = {};
  const pdf = await danfePelaTela(page, { tipo: String(e.tipoIdentificacao ?? '1'), identificacao: e.identificacao, vias: e.vias, info });
  await evidencia('reimpressao');
  if (!pdf) throw new Error('Não consegui gerar o PDF. A NFA só pode ser impressa até a data de saída.');
  const url = await guardarArquivo('danfe.pdf', pdf);
  return { ...(info.numero ? { numero: info.numero } : {}), ...(info.serie ? { serie: info.serie } : {}), mensagem: 'PDF da nota gerado.' + (info.numero ? ` NFA ${info.numero}${info.serie ? ', série ' + info.serie : ''}.` : ''), pdfs: [{ nome: 'Nota fiscal (DANFE)', url }] };
}

/** Aviso em vermelho do SIARE logo abaixo do título da tela (recusa sem página de erro). */
export async function avisoNoTopo(page) {
  return page.evaluate(() => {
    const t = ((document.body && document.body.innerText) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const l = t.find((x) => /removido ou nunca existiu|inv[áa]lid|n[ãa]o (foi )?(encontrad|localizad)|n[ãa]o pode|j[áa] (foi|est[áa])/i.test(x) && x.length < 200);
    return l || '';
  }).catch(() => '');
}

// ---------------- nfa.cancelar (irreversível) ----------------
export async function cancelarNfa({ page, entradas, etapa, evidencia, pausar, guardarArquivo }) {
  const e = entradas || {};
  if (!e.numero || !e.ano || !e.justificativa) throw new Error('Falta número, ano ou justificativa.');
  etapa('Abrindo o cancelamento');
  await abrir(page, SOL + '/NFAE/SERVICO_011?ACAO=NOVO', '[name="nrNFA"], [name="justificativa"]');
  await radio(page, 'rdgNotaFiscalAvulsa', String(e.tipoDocumento ?? '2'));
  await texto(page, 'nrNFA', digitos(e.numero));
  await texto(page, 'dataEmissao', digitos(e.ano));
  await texto(page, 'justificativa', e.justificativa);
  await evidencia('cancelamento-preenchido');
  await pausar([['Nota', digitos(e.numero)], ['Ano', digitos(e.ano)], ['Justificativa', String(e.justificativa).slice(0, 80)]]);
  etapa('Enviando o pedido de cancelamento');
  // O botão "Confirmar" da tela (visto em 15/10/2026): usa o verbo e a URL do próprio onclick.
  const verbo = (await botaoDaTela(page, 'CONFNOVO')) ? 'CONFNOVO' : 'CONFIRMAR';
  await acaoDoBotao(page, verbo, { urlPadrao: SOL + '/NFAE/SERVICO_011', valida: true, tetoMs: 90000 });
  await dormir(2000);
  const protocolo = await lerProtocolo(page);
  await evidencia('cancelamento-resultado');
  // Dentro do prazo a tela só diz "O Cancelamento foi efetuado com sucesso!" (sem
  // protocolo) — visto em 15/10/2026 com a NFA-e 053.516.840.
  const txt = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  if (/cancelamento foi efetuado com sucesso/i.test(txt)) {
    // O SIARE não dá comprovante para imprimir: guarda a própria tela de confirmação em PDF.
    const pdfs = [];
    try {
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      if (guardarArquivo) pdfs.push({ nome: 'Comprovante do cancelamento', url: await guardarArquivo('comprovante-cancelamento.pdf', pdf) });
    } catch { /* segue sem o PDF; a evidência (print) fica */ }
    return { ...(protocolo ? { protocolo } : {}), confirmado: true, mensagem: 'NFA cancelada. O SIARE confirmou: "O Cancelamento foi efetuado com sucesso!"', ...(pdfs.length ? { pdfs } : {}) };
  }
  // Fora do prazo (MAGNU §15): vira pedido para a Fazenda, com protocolo + SENHA e
  // uma folha dizendo para qual AF mandar os documentos. A nota continua valendo até
  // a AF deferir. Guarda a tela e o comprovante do protocolo em PDF.
  exigirProtocolo(protocolo);
  const senha = (txt.match(/[Ss]enha[^:\n]*:\s*([A-Za-z0-9]{4,})/) || [])[1] || '';
  const af = ((txt.match(/\bAF\s*\d{3,}[^\n]*/) || [])[0] || '').trim().slice(0, 120);
  const pdfs = [];
  if (guardarArquivo) {
    try { pdfs.push({ nome: 'Pedido de cancelamento', url: await guardarArquivo('pedido-cancelamento.pdf', await page.pdf({ format: 'A4', printBackground: true })) }); } catch { /* fica o print */ }
    try {
      const pc = await page.browser().newPage();
      await pc.goto(SOL + '/PROTOCOL/IMPRESSAO_PROTOCOLO?numProtocolo=' + digitos(protocolo) + '&ACAO=VISUALIZAR', { waitUntil: 'networkidle2', timeout: 60000 });
      pdfs.push({ nome: 'Comprovante do protocolo', url: await guardarArquivo('comprovante-protocolo.pdf', await pc.pdf({ format: 'A4', printBackground: true })) });
      await pc.close().catch(() => undefined);
    } catch { /* segue com a tela */ }
  }
  return {
    protocolo,
    ...(senha ? { senha } : {}),
    mensagem: 'Fora do prazo: virou pedido para a Fazenda. A nota continua valendo até ser deferido.' + (af ? ` Documentos para ${af}.` : '') + (senha ? ` Senha do protocolo: ${senha}.` : ''),
    ...(pdfs.length ? { pdfs } : {}),
  };
}

// ---------------- nfa.offline (pedido) ----------------
export async function autorizarNfaOffline({ page, produtor, etapa, evidencia, pausar }) {
  etapa('Abrindo a autorização de NFA offline');
  await abrir(page, SOL + '/NFAE/SERVICO_185?ACAO=VISUALIZAR', null);
  // A tela traz a IE do produtor (campo/seleção cbxNumeroIEPR).
  // A lista traz a IE mascarada ("001234567.00-89"): casa pelos dígitos.
  if (!(await selecionarPorDigitos(page, 'cbxNumeroIEPR', produtor?.ie))) {
    throw new Error('A IE do produtor não aparece na lista da NFA offline.');
  }
  // A lista é jquery.selectbox: confirma pelo clique no item (senão a tela mostra "Selecione").
  const valorIE = await page.evaluate(() => (document.querySelector('select[name="cbxNumeroIEPR"]') || {}).value || '').catch(() => '');
  if (valorIE) await escolher(page, 'cbxNumeroIEPR', valorIE);
  await evidencia('offline-preenchido');
  await pausar([['IE', produtor?.ie || ''], ['Pedido', 'Autorização para NFA offline']]);
  etapa('Enviando a solicitação');
  await acao(page, { url: SOL + '/NFAE/SERVICO_185', acaoSiare: 'CONFIRMAR', valida: true });
  await dormir(2000);
  const protocolo = await lerProtocolo(page);
  await evidencia('offline-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: 'Autorização de NFA offline solicitada.' };
}

// ---------------- saida.registrar (pedido) ----------------
export async function registrarSaida({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  const regs = Array.isArray(e.registros) ? e.registros : [];
  if (!regs.length) throw new Error('Nenhuma chave de acesso informada.');
  etapa('Abrindo o registro de saída');
  await abrir(page, SOL + '/MONITDOC/SERVICO_001?ACAO=VISUALIZAR', '[name="chaveAcesso.valor"], [name="dataSaida"]');
  let incluidos = 0;
  for (const r of regs) {
    await texto(page, 'chaveAcesso.valor', digitos(r.chave));
    await texto(page, 'numSequencial', String(r.sequencial ?? ''));
    await texto(page, 'dataSaida', r.data || '', true);
    await texto(page, 'horaSaida', r.hora || '', true);
    if (r.placa) await texto(page, 'placaVeiculo.identificacao', r.placa);
    if (r.ufPlaca) await selecionar(page, 'placaVeiculo.codigoUF', r.ufPlaca);
    // Carretas: o app não pede a UF delas; usa a da placa do veículo.
    if (r.carreta1) { await texto(page, 'placaCarreta.identificacao', r.carreta1); if (r.ufPlaca) await selecionar(page, 'placaCarreta.codigoUF', r.ufPlaca); }
    if (r.carreta2) { await texto(page, 'placaCarreta2.identificacao', r.carreta2); if (r.ufPlaca) await selecionar(page, 'placaCarreta2.codigoUF', r.ufPlaca); }
    await acao(page, { url: SOL + '/MONITDOC/SERVICO_001', acaoSiare: 'CONFNOVO' }); // seta_inclui: põe na grade
    // O SIARE avisa em vermelho no topo (ex.: "O registro de Contribuinte informado já foi removido ou nunca existiu.").
    const aviso = await avisoNoTopo(page);
    if (aviso) throw new Error('O SIARE recusou a chave ' + digitos(r.chave) + ': ' + aviso);
    incluidos++;
  }
  if (e.vias) await texto(page, 'quantidadeVias', String(e.vias));
  await evidencia('saida-preenchida');
  await pausar([['Chaves', String(incluidos)], ['Vias', String(e.vias || '')]]);
  etapa('Registrando a saída');
  await acao(page, { url: SOL + '/MONITDOC/SERVICO_001', acaoSiare: 'CONFIRMAR', valida: true });
  await dormir(2000);
  const protocolo = await lerProtocolo(page);
  await evidencia('saida-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: `Saída registrada (${incluidos} chave${incluidos > 1 ? 's' : ''}).` };
}

// ---------------- saida.cancelar (irreversível) ----------------
export async function cancelarSaida({ page, entradas, etapa, evidencia, pausar }) {
  const e = entradas || {};
  if (!e.chave || !e.protocolo || !e.motivo) throw new Error('Falta chave, protocolo ou motivo.');
  etapa('Abrindo o cancelamento de saída');
  await abrir(page, SOL + '/MONITDOC/SERVICO_003?ACAO=VISUALIZAR', '[name="txtChaveAcesso"]');
  await texto(page, 'txtChaveAcesso', digitos(e.chave));
  await texto(page, 'txtNrProtocolo', digitos(e.protocolo));
  await texto(page, 'txtMotivo', e.motivo);
  await evidencia('cancela-saida-preenchido');
  await pausar([['Chave', digitos(e.chave).slice(0, 12) + '…'], ['Protocolo', digitos(e.protocolo)], ['Motivo', String(e.motivo).slice(0, 80)]]);
  etapa('Enviando o cancelamento');
  await acao(page, { url: SOL + '/MONITDOC/SERVICO_003', acaoSiare: 'CONFIRMAR', valida: true });
  await dormir(2000);
  const protocolo = await lerProtocolo(page);
  await evidencia('cancela-saida-resultado');
  exigirProtocolo(protocolo);
  return { protocolo, mensagem: 'Cancelamento do registro de saída enviado.' };
}
