// A recusa da PONTE ao pedir a senha do SIARE, como o produtor lê.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { criarCofreDaPonte, LICENCA_PARADA } from '../cofre-ponte.mjs';

const ponteQueResponde = (status, corpo) => async () => new Response(JSON.stringify(corpo), { status });

test('cliente pausado por mensalidade: o produtor lê que volta com o pagamento, e não a frase do operador', async () => {
  const cofre = criarCofreDaPonte({
    url: 'https://ponte.exemplo',
    chave: 'chave-de-teste',
    buscar: ponteQueResponde(401, { erro: 'Regularizar a cobranca e voltar o cliente para ativo.', codigo: 'cliente-inadimplente' }),
  });
  await assert.rejects(() => cofre.credencial('0000000000191'), (e) => {
    assert.equal(e.message, LICENCA_PARADA['cliente-inadimplente']);
    assert.doesNotMatch(e.message, /Regularizar|rob[oô]/i);
    return true;
  });
});

test('chave do servidor recusada: a mensagem não fala em robô nem em variável do Render', async () => {
  const erro = console.error;
  console.error = () => {};
  try {
    const cofre = criarCofreDaPonte({ url: 'https://ponte.exemplo', chave: 'chave-de-teste', buscar: ponteQueResponde(401, { erro: 'Chave invalida.' }) });
    await assert.rejects(() => cofre.credencial('0000000000191'), (e) => {
      assert.doesNotMatch(e.message, /rob[oô]|PONTE_CHAVE_ROBO|Render/i);
      assert.match(e.message, /Fale com quem instalou/);
      return true;
    });
  } finally {
    console.error = erro;
  }
});
