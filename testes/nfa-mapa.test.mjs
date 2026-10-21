// Tradução dos dados do app para os campos do SIARE (parte pura da emissão).
// Isto roda sem navegador; o fluxo na tela só dá para testar no SIARE real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  aliquotaDoPortal, camposBasicos, camposDevolucao, camposEstrangeiro, camposDadosIniciais, camposItem, camposTotais, descontosDosItens, ladoDaOutraParte, percentualDoPortal, tributacaoDoItem, linhaDeEndereco, municipioEUf, pesoDoPortal, quantidadeDoPortal, tipoDeLogradouro, valorDoPortal,
} from '../siare-nfa.mjs';
import { cpfCnpjComMascara } from '../siare-dom.mjs';
import { mascaraRE } from '../siare-sol2.mjs';

describe('emissão NFA: tradução para o SIARE', () => {
  test('dinheiro, quantidade e peso no formato do portal', () => {
    assert.equal(valorDoPortal(0.9), '0,9000');
    assert.equal(valorDoPortal(1500), '1500,0000');
    assert.equal(quantidadeDoPortal(2400), '2400');
    assert.equal(quantidadeDoPortal(10.5), '10,5');
    assert.equal(pesoDoPortal(6300), '630000'); // 6.300,00 → 2 casas implícitas
  });

  test('básicos: saída vira rdgTipoNFA=false; booleanos viram true/false', () => {
    const c = camposBasicos({ tipoNFA: 'saida', circulacao: '2', natureza: '3', finalidade: '1', suframa: false, regimeEspecial: false });
    assert.deepEqual(c, { rdgTipoNFA: 'false', tipoCirculacao: '2', tipoNatureza: '3', finalidadeEmissao: '1', rdgSuframa: 'false', rdgRegimeEspecial: 'false' });
    assert.equal(camposBasicos({ tipoNFA: 'entrada' }).rdgTipoNFA, 'true');
    assert.equal(camposBasicos({ suframa: true }).rdgSuframa, 'true');
  });

  test('dados iniciais: hora só na saída; órgão público liga a nota de empenho', () => {
    const saida = camposDadosIniciais({ tipoNFA: 'saida', cfop: '6101', dataSaida: '14/10/2026', horaSaida: '14:30' });
    assert.equal(saida['cfop.id'], '6101');
    assert.equal(saida.dataSaidaEntrada, '14/10/2026');
    assert.equal(saida.horaSaida, '14:30');
    const entrada = camposDadosIniciais({ tipoNFA: 'entrada', cfop: '1101', dataSaida: '14/10/2026', horaSaida: '14:30' });
    assert.equal(entrada.horaSaida, undefined, 'entrada não tem hora');
    const orgao = camposDadosIniciais({ tipoNFA: 'saida', cfop: '6101', dataSaida: '14/10/2026', orgaoPublico: true, notaEmpenho: '12345' });
    assert.equal(orgao.vendaOrgaoPublico, 'true');
    assert.equal(orgao.notaEmpenho, '12345');
  });

  test('item: NCM só dígitos, descrição até 60, grupo/origem/unidade pelo código', () => {
    const c = camposItem({ grupo: '8', ncm: '0803.90.00', descricao: 'BANANA PRATA', origem: '0', unidade: '6', quantidade: 2400, valorUnitario: 0.9 });
    assert.equal(c.cmbGrupo, '8');
    assert.equal(c['subItemNcm.codigo'], '08039000');
    assert.equal(c.cmbOrigem, '0');
    assert.equal(c.cmbUnidadeMedida, '6');
    assert.equal(c.quantidade, '2400');
    assert.equal(c.valorUnitario, '0,9000');
    assert.equal(camposItem({ descricao: 'x'.repeat(80) }).descricao.length, 60);
  });

  test('item: grupo digitado (código) vence o da lista', () => {
    assert.equal(camposItem({ grupo: '23', grupoCodigo: 151 }).cmbGrupo, '151');
  });

  test('totais da aba Produtos: só o que veio, alíquotas como "4.0"', () => {
    assert.deepEqual(camposTotais({}), {});
    const t = camposTotais({ valorFrete: 150, aliquotaFrete: '4', credPresFrete: '10', outrasDespesas: 2.5 });
    assert.equal(t.valorFrete, '150,00');
    assert.equal(t.outrasDespAcessorias, '2,50');
    assert.equal(t['aliquotaBCFrete.valorString'], '4.0');
    assert.equal(t['aliquotaBCCreditoPresumido.valorString'], '10.0');
    assert.equal(aliquotaDoPortal('0'), '0.0');
  });

  test('CPF/CNPJ com a máscara da tela (a lupa só acha assim)', () => {
    assert.equal(cpfCnpjComMascara('12345678909'), '123.456.789-09');
    assert.equal(cpfCnpjComMascara('11.222.333/0001-81'), '11.222.333/0001-81');
    assert.equal(cpfCnpjComMascara('11222333000181'), '11.222.333/0001-81');
  });

  test('tipo de logradouro pela 1ª palavra; sem casar, OUTROS', () => {
    const tipos = ['RUA', 'FAZENDA', 'ZONA RURAL', 'SÍTIO', 'OUTROS'];
    assert.deepEqual(tipoDeLogradouro('Fazenda Boa Vista', tipos), { tipo: 'FAZENDA', resto: 'Boa Vista' });
    assert.deepEqual(tipoDeLogradouro('sitio do meio', tipos), { tipo: 'SÍTIO', resto: 'do meio' });
    assert.deepEqual(tipoDeLogradouro('Zona Rural', tipos), { tipo: 'ZONA RURAL', resto: 'Zona Rural' });
    assert.deepEqual(tipoDeLogradouro('Córrego Fundo', tipos), { tipo: 'OUTROS', resto: 'Córrego Fundo' });
  });

  test('linha de endereço: 29 partes na ordem da janelinha, sem vírgula solta', () => {
    const l = linhaDeEndereco({ cep: '39508-000', sgUf: 'MG', nomeUF: 'MINAS GERAIS', idMunicipio: '3288', nomeMunicipio: 'JAIBA', bairro: 'Centro, perto', tipoLogradouro: 'RUA', logradouro: 'A', numero: '' });
    const p = l.split(',');
    assert.equal(p.length, 29);
    assert.deepEqual(p.slice(0, 10), ['39508000', 'MG', 'MINAS GERAIS', '3288', 'JAIBA', '', 'Centro  perto', 'RUA', 'A', 'S/N']);
  });

  test('município de início: nome sem acento e UF (padrão MG)', () => {
    assert.deepEqual(municipioEUf('Jaíba/MG'), { nome: 'JAIBA', uf: 'MG' });
    assert.deepEqual(municipioEUf('Montes Claros - mg'), { nome: 'MONTES CLAROS', uf: 'MG' });
    assert.deepEqual(municipioEUf('Uberaba'), { nome: 'UBERABA', uf: 'MG' });
    assert.deepEqual(municipioEUf('São João del-Rei'), { nome: 'SAO JOAO DEL-REI', uf: 'MG' });
  });

  test('imposto por item no formato das listas do SIARE', () => {
    assert.deepEqual(tributacaoDoItem({ cst: '00', aliquota: '12', reducao: '33,33', credPres: '98,5714' }), { cst: '0', aliquota: '12.0', bc: '33.33', credPres: '98.5714' });
    assert.deepEqual(tributacaoDoItem({ cst: '40' }), { cst: '40' });
    assert.deepEqual(tributacaoDoItem({}), {});
    assert.equal(percentualDoPortal('4,9'), '4.9');
    assert.equal(percentualDoPortal('125'), '125.0');
    assert.equal(percentualDoPortal('2,508'), '2.508');
  });

  test('desconto por item: vírgula, número ou vazio', () => {
    assert.deepEqual(descontosDosItens([{ desconto: '415,08' }, {}, { desconto: 2.5 }, { desconto: '1.234,56' }, { desconto: '-3' }]), [415.08, 0, 2.5, 1234.56, 0]);
  });

  test('número do RE/PTA com a máscara da tela', () => {
    assert.equal(mascaraRE('4500001234567'), '45.000012345-67');
    assert.equal(mascaraRE('45.000012345-67'), '45.000012345-67');
  });

  test('finalidade: o app esconde na devolução e manda em _derivado; sem nada, natureza 7 = 4', () => {
    assert.equal(camposBasicos({ natureza: '7', _derivado: { finalidade: '4' } }).finalidadeEmissao, '4');
    assert.equal(camposBasicos({ natureza: '7' }).finalidadeEmissao, '4');
    assert.equal(camposBasicos({ natureza: '3', finalidade: '1', _derivado: { finalidade: '1' } }).finalidadeEmissao, '1');
  });

  test('exterior: destinatário estrangeiro com país, cidade e embarque; telefone só com dígitos', () => {
    const r = camposEstrangeiro({ nome: 'IMPORTADORA TESTE', idEstrangeiro: 'AR-123', fone: '+54 11 5555-0000', pais: 'Argentina', cidade: 'Buenos Aires', logradouro: 'Av. Teste', numero: '100' }, { localEmbarque: 'Porto de Santos', ufEmbarque: 'sp' });
    assert.deepEqual(r.textos.map(([n]) => n), ['destinatario.nome', 'destinatario.idEstrangeiro', 'destinatario.foneFax', 'enderecoDestinatario.municipio', 'enderecoDestinatario.logradouro', 'enderecoDestinatario.numero', 'enderecoDestinatario.localEmbarque']);
    assert.equal(r.textos.find(([n]) => n === 'destinatario.foneFax')[1], '541155550000');
    assert.equal(r.pais, 'Argentina');
    assert.equal(r.ufEmbarque, 'SP');
  });

  test('nota devolvida: chave (NF-e/NFA-e), papel (número, série, CNPJ, mês/ano) e cupom', () => {
    assert.deepEqual(camposDevolucao({ tipo: '3', chave: '3126 1016 9077 4600 0113 5589 1053 5168 4011 8629 1520' }), { tipo: '3', campos: [['devolucaoNFA.chaveAcesso', '31261016907746000113558910535168401186291520']], lista: [] });
    const papel = camposDevolucao({ tipo: '1', numero: '1234', serie: '1', cnpjEmitente: '26118897000146', mesAno: '10/26' });
    assert.deepEqual(papel.campos, [['devolucaoNFA.numeroDocumentoFiscal', '1234'], ['devolucaoNFA.serieDocumentoFiscal', '1'], ['devolucaoNFA.cnpjEmitente', '26.118.897/0001-46'], ['devolucaoNFA.mesAnoDocumentoFiscal', '10/26']]);
    assert.deepEqual(papel.lista, [['devolucaoNFA.codigoIbgeUfEmitente', '31']]);
    const cupom = camposDevolucao({ tipo: '6', coo: '123', ecf: '1', codigoEcf: '2d' });
    assert.deepEqual(cupom.campos, [['devolucaoNFA.numeroCOO', '123'], ['devolucaoNFA.numeroEquipamentoEmissor', '1']]);
    assert.deepEqual(cupom.lista, [['devolucaoNFA.tipoCupomFiscal.identificador', '10']]);
    assert.deepEqual(camposDevolucao(undefined), { tipo: '', campos: [], lista: [] });
  });

  test('consumidor final de outro estado: alíquota interestadual, interna do destino, base e FCP', () => {
    assert.deepEqual(tributacaoDoItem({ cst: '00', aliquota: '12', aliqInterest: '12', aliqInternaDest: '18', bcDest: '1.220,50', fcp: '2' }), {
      cst: '0', aliquota: '12.0', aliqInterest: '12.0', difal: { aliqInternaUFDest: '18,00', valBCIcmsUFDest: '1220,50', aliqFCPUFDest: '2,00' },
    });
  });

  test('lado da outra parte: saída=destinatário, entrada=remetente', () => {
    assert.equal(ladoDaOutraParte({ tipoNFA: 'saida' }), 'destinatario');
    assert.equal(ladoDaOutraParte({ tipoNFA: 'entrada' }), 'remetente');
  });
});
