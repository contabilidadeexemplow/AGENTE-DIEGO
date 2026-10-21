// Alteração cadastral: o que vai mudar e os avisos (parte pura).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { camposNovaPropriedade, codigoCnae, mudancasDeCadastro, TIPOS_SOCIEDADE } from '../siare-pr.mjs';

describe('alteração: o que muda', () => {
  test('só os campos preenchidos entram; a prévia mostra Sim/Não', () => {
    const r = mudancasDeCadastro({ email: 'a@b.com', optanteLeite: 'true', telefone: '31999990000' });
    assert.equal(r.mudancas.length, 3);
    assert.ok(r.previa.find(([k, v]) => k === 'E-mail' && v === 'a@b.com'));
    assert.ok(r.previa.find(([k, v]) => k.includes('Leite') && v === 'Sim'));
    assert.equal(r.avisos.length, 0);
  });

  test('CNAE vira o código da tela; proprietário entra com CPF/CNPJ válido', () => {
    const r = mudancasDeCadastro({ cnaePrincipal: '0151201', cnaeSecundaria: '0133-4/02', proprietarios: [{ cpfCnpj: '111.444.777-35', nome: 'FULANO' }, { cpfCnpj: '1', nome: 'X' }] });
    assert.equal(r.mudancas.length, 0);
    assert.deepEqual(r.cnaes.map((c) => [c.qual, c.codigo]), [[1, '0151-2/01'], [2, '0133-4/02']]);
    assert.deepEqual(r.proprietarios, [{ doc: '11144477735', nome: 'FULANO' }]);
    assert.ok(r.previa.find(([k, v]) => k === 'CNAE principal' && v === '0151-2/01'));
    assert.ok(r.previa.find(([k, v]) => k === 'Incluir proprietário' && v === 'FULANO · 11144477735'));
    assert.equal(r.avisos.length, 1);
    assert.ok(/X/.test(r.avisos[0]));
  });

  test('CNAE sem 7 dígitos vira aviso e não muda', () => {
    const r = mudancasDeCadastro({ cnaePrincipal: '0151' });
    assert.equal(r.cnaes.length, 0);
    assert.equal(r.avisos.length, 1);
    assert.equal(codigoCnae('0151'), '');
  });

  test('sociedade: tipo e participantes válidos; sem eles, aviso', () => {
    const r = mudancasDeCadastro({ sociedade: 'true', tipoSociedade: '4', socios: [{ cpf: '111.444.777-35', participacao: 50, dataNascimento: '01/02/1980' }, { cpf: '1', participacao: 10, dataNascimento: '01/01/2000' }] });
    assert.deepEqual(r.sociedade, { tipo: '4', socios: [{ cpf: '11144477735', participacao: '50', dataNascimento: '01/02/1980', tipoCoTitular: '' }] });
    assert.ok(r.previa.find(([k, v]) => k === 'Tipo de sociedade' && v === TIPOS_SOCIEDADE[4]));
    assert.ok(r.previa.find(([k, v]) => k === 'Incluir participante' && v === '11144477735 · 50%'));
    assert.equal(r.avisos.length, 1);
    assert.equal(mudancasDeCadastro({ sociedade: 'true' }).avisos.length, 1);
    assert.equal(mudancasDeCadastro({ sociedade: 'false', tipoSociedade: '4' }).sociedade, null);
  });

  test('nada preenchido = nenhuma mudança', () => {
    assert.equal(mudancasDeCadastro({}).mudancas.length, 0);
  });

  test('nova propriedade: exige CNAE, vínculo, áreas, CEP e endereço; áreas com vírgula', () => {
    const falta = camposNovaPropriedade({}).faltam;
    for (const t of ['nome da propriedade', 'CNAE principal (7 dígitos)', 'vínculo com o imóvel', 'área do imóvel', 'área explorada', 'CEP', 'endereço e bairro']) assert.ok(falta.includes(t), t);
    const r = camposNovaPropriedade({ nomeEstabelecimento: 'SITIO NOVO', cnaePrincipal: '0133402', vinculo: '3', areaImovel: 5.5, areaExploracao: 4, cep: '39508-000', logradouro: 'ESTRADA', bairro: 'ZONA RURAL', email: 'a@b.com', telefone: '(38) 99999-0000' });
    assert.deepEqual(r.faltam, []);
    assert.ok(r.estab.find(([n, v]) => n === 'areaImovel' && v === '5,5'));
    assert.ok(r.contato.find(([n, v]) => n === 'comunicacao.telefone' && v === '38999990000'));
    assert.equal(r.declEstoque, false);
  });
});
