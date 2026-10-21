// Emissão de DAE: tradução das entradas do app para os campos do SIARE (parte pura).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { camposDoDae, mesEAno, vencido } from '../siare-dae.mjs';

describe('emissão de DAE: tradução para o SIARE', () => {
  test('mês de referência em vários jeitos', () => {
    assert.deepEqual(mesEAno('10/2026'), { mes: '10', ano: '2026' });
    assert.deepEqual(mesEAno('9/2026'), { mes: '9', ano: '2026' });
    assert.deepEqual(mesEAno('2026-09'), { mes: '9', ano: '2026' });
    assert.deepEqual(mesEAno('setembro'), { mes: '', ano: '' });
  });

  test('campos: período pelo código da tela, dinheiro com vírgula, só o que veio', () => {
    const c = camposDoDae({ vencimento: '20/10/2026', pagamento: '15/10/2026', periodo: 'Q2', mesReferencia: '09/2026', valorReceita: '1.234,5', informacoes: 'x' });
    assert.deepEqual(c, { dtVencimento: '20/10/2026', dtPagamento: '15/10/2026', cmbPeriodo: '3', cmbMes: '9', cmbAno: '2026', txtReceita: '1234,50', txtInformacoes: 'x' });
    assert.equal(camposDoDae({ valorReceita: 10 }).txtReceita, '10,00');
    assert.equal(camposDoDae({ periodo: 'D3' }).cmbPeriodo, '6');
    assert.deepEqual(camposDoDae({ trimestre: 2, exercicio: 2026, protocolo: '12.345' }), { cmbTrimestre: '2', cmbExercicio: '2026', txtProtocolo: '12345' });
  });

  test('vencido: só quando o pagamento é depois do vencimento', () => {
    assert.equal(vencido('10/10/2026', '15/10/2026'), true);
    assert.equal(vencido('15/10/2026', '15/10/2026'), false);
    assert.equal(vencido('20/10/2026', '15/10/2026'), false);
    assert.equal(vencido('', '15/10/2026'), false);
  });
});
