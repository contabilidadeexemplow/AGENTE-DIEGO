// Cofre das senhas: guarda cifrado, usa no login, nunca vaza a senha.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarCofre } from '../cofre.mjs';

const novo = () => join(mkdtempSync(join(tmpdir(), 'af-cofre-')), 'credenciais.json');

describe('cofre', () => {
  test('guarda a senha cifrada e devolve a credencial para o login', () => {
    const arq = novo();
    const cofre = criarCofre({ arquivo: arq, segredo: 'chave-de-teste' });
    cofre.guardar({ ie: '0000000000272', cpf: '111.444.777-35', senha: 'senha-secreta-do-siare' });
    assert.equal(cofre.tem('0000000000272'), true);
    const c = cofre.credencial('00000000-00272');
    assert.equal(c.senha, 'senha-secreta-do-siare');
    assert.equal(c.cpf, '11144477735');
    assert.equal(c.dominio, 'Produtor Rural');
  });

  test('o arquivo em disco não tem a senha em texto aberto', () => {
    const arq = novo();
    criarCofre({ arquivo: arq, segredo: 'k' }).guardar({ ie: '0000000000272', cpf: '11144477735', senha: 'senha-secreta-do-siare' });
    const bruto = readFileSync(arq, 'utf8');
    assert.doesNotMatch(bruto, /senha-secreta-do-siare/);
    assert.match(bruto, /senhaCifrada/);
  });

  test('outra chave não decifra (senão não voltaria null)', () => {
    const arq = novo();
    criarCofre({ arquivo: arq, segredo: 'chave-certa' }).guardar({ ie: '0000000000272', cpf: '11144477735', senha: 'x' });
    assert.equal(criarCofre({ arquivo: arq, segredo: 'chave-errada' }).credencial('0000000000272'), null);
  });

  test('sobrevive ao reinício (relê do disco)', () => {
    const arq = novo();
    criarCofre({ arquivo: arq, segredo: 'k' }).guardar({ ie: '0012345670089', cpf: '12345678909', senha: 'abc' });
    assert.equal(criarCofre({ arquivo: arq, segredo: 'k' }).credencial('0012345670089').senha, 'abc');
  });

  test('lista só diz quais IEs têm senha, nunca a senha', () => {
    const arq = novo();
    const cofre = criarCofre({ arquivo: arq, segredo: 'k', base: new Map([['9999999999999', { cpf: '1', senha: 'do-segredo', dominio: 'Produtor Rural' }]]) });
    cofre.guardar({ ie: '0000000000272', cpf: '11144477735', senha: 'do-app' });
    const l = cofre.lista();
    assert.equal(JSON.stringify(l).includes('do-app'), false);
    assert.equal(JSON.stringify(l).includes('do-segredo'), false);
    assert.deepEqual(l.find((x) => x.ie === '0000000000272'), { ie: '0000000000272', origem: 'app' });
    assert.deepEqual(l.find((x) => x.ie === '9999999999999'), { ie: '9999999999999', origem: 'segredo' });
  });

  test('remover apaga e recusa dados tortos', () => {
    const arq = novo();
    const cofre = criarCofre({ arquivo: arq, segredo: 'k' });
    cofre.guardar({ ie: '0000000000272', cpf: '11144477735', senha: 'x' });
    assert.equal(cofre.remover('0000000000272'), true);
    assert.equal(cofre.tem('0000000000272'), false);
    assert.throws(() => cofre.guardar({ ie: '123', cpf: '11144477735', senha: 'x' }), /13 dígitos/);
    assert.throws(() => cofre.guardar({ ie: '0000000000272', cpf: '1', senha: 'x' }), /CPF/);
    assert.throws(() => cofre.guardar({ ie: '0000000000272', cpf: '11144477735', senha: '' }), /senha/);
  });
});
