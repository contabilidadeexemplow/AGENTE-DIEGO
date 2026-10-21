// Testes do servidor do AGRO FÁCIL (node --test). O SIARE e o navegador são
// imitações: nada aqui sai da máquina nem entra no SIARE de verdade.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarServidor } from '../app.mjs';
import { lerConfig, lerCredenciais } from '../config.mjs';
import { criarCofreDaPonte } from '../cofre-ponte.mjs';

const PRODUTOR = { nome: 'PRODUTOR DE TESTE', ie: '0000000000191', cpf: '52998224725', acesso: 'cofre' };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function paginaFalsa() {
  return {
    on() {},
    evaluate: async () => { throw new Error('sem DOM'); },
    screenshot: async () => undefined,
    content: async () => '<html></html>',
  };
}

const execucoes = [];
const CORDAS = {
  'teste.consulta': async ({ etapa }) => { execucoes.push('consulta'); etapa('Lendo a tela'); await dormir(30); return { mensagem: 'Lido.', itens: ['linha 1'] }; },
  'teste.nota': async ({ etapa, pausar }) => { execucoes.push('nota'); etapa('Preenchendo'); await pausar([['Total da nota', 'R$ 10,00']]); return { protocolo: 'P-123', mensagem: 'Nota emitida.' }; },
  'teste.semprotocolo': async ({ pausar }) => { await pausar([['Total', 'R$ 1,00']]); return { mensagem: 'Sem número.' }; },
  'teste.errodepois': async ({ pausar }) => { await pausar([['Total', 'R$ 1,00']]); throw new Error('A tela final não abriu.'); },
  'teste.confirmado': async ({ pausar }) => { await pausar([['Pedido', 'relatório']]); return { confirmado: true, mensagem: 'Pedido na fila.' }; },
  'teste.anexo': async ({ entradas, anexo }) => { const a = anexo(entradas.arquivo); return { mensagem: a ? 'Anexo: ' + a.nome + ' ' + readFileSync(a.caminho, 'utf8') : 'sem anexo' }; },
  'teste.publica': Object.assign(async () => ({ mensagem: 'Tela pública lida.' }), { semLogin: true }),
};

function configTeste(extra = {}) {
  const dados = mkdtempSync(join(tmpdir(), 'af-dados-'));
  const app = mkdtempSync(join(tmpdir(), 'af-app-'));
  writeFileSync(join(app, 'index.html'), '<!doctype html><title>AGRO FÁCIL</title>');
  mkdirSync(join(app, 'assets'));
  writeFileSync(join(app, 'assets', 'a.js'), 'console.log(1)');
  return {
    naNuvem: false, host: '127.0.0.1', porta: 0, semJanela: true, navegador: '',
    codigoAcesso: '', segredoSessao: '', origens: [], dados, app,
    pausaEntreLoginsMs: 0, tetoConfirmacaoMs: 3000, tetoLoginAssistidoMs: 1000,
    credenciais: new Map([['0000000000191', { cpf: '52998224725', senha: 'nao-usada-nos-testes', dominio: 'Produtor Rural' }]]),
    ...extra,
  };
}

async function subir(cfg, deps = {}) {
  const app = criarServidor(cfg, {
    cordas: CORDAS,
    abrirNavegador: async () => ({ page: paginaFalsa(), fechar: async () => undefined }),
    entrarNoSiare: async (_page, produtor, { etapa }) => {
      etapa('Entrando no SIARE');
      if (produtor.ie === '9999999999999') throw new Error('O SIARE recusou o acesso.');
    },
    ...deps,
  });
  await new Promise((r) => app.servidor.listen(0, '127.0.0.1', r));
  app.iniciar();
  const base = `http://127.0.0.1:${app.servidor.address().port}`;
  let cookie = '';
  const pedir = async (metodo, caminho, corpo, cabecalhos = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(metodo === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...cabecalhos },
      body: metodo === 'POST' ? JSON.stringify(corpo ?? {}) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const tipo = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, corpo: tipo.includes('json') ? await r.json() : await r.text() };
  };
  const esperarEstado = async (id, estados, teto = 4000) => {
    const ate = Date.now() + teto;
    for (;;) {
      const r = await pedir('GET', '/comandos/' + id);
      if (estados.includes(r.corpo.estado)) return r.corpo;
      if (Date.now() > ate) throw new Error(`pedido ${id} ficou em ${r.corpo.estado}`);
      await dormir(20);
    }
  };
  const comando = (processo, extra = {}) => ({ versao: 1, processo, titulo: processo, risco: processo === 'teste.consulta' ? 'consulta' : 'irreversivel', produtor: PRODUTOR, entradas: {}, chaveIdempotencia: processo + Math.random(), ...extra });
  return { app, cfg, base, pedir, esperarEstado, comando, fechar: () => app.encerrar() };
}

describe('servidor no PC (sem código de acesso)', () => {
  let s;
  before(async () => { s = await subir(configTeste()); });
  after(async () => { await s.fechar(); });

  test('/health responde e o aplicativo sai com cabeçalhos de segurança', async () => {
    const h = await s.pedir('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.corpo.ok, true);
    const pagina = await s.pedir('GET', '/');
    assert.equal(pagina.status, 200);
    assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(pagina.headers.get('x-frame-options'), 'DENY');
    const js = await s.pedir('GET', '/assets/a.js');
    assert.match(js.headers.get('cache-control'), /immutable/);
    const fora = await s.pedir('GET', '/../config.mjs');
    assert.notEqual(fora.status, 200);
  });

  test('sem PING_SEGREDO não há "Acordar agora"', async () => {
    assert.notEqual((await s.pedir('GET', '/acordar/qualquer-coisa-longa')).status, 202);
  });

  test('POST sem JSON é recusado (nenhuma página de fora manda comando escondido)', async () => {
    const r = await fetch(s.base + '/comandos', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 415);
  });

  test('/cordas lista o que é executado', async () => {
    const r = await s.pedir('GET', '/cordas');
    assert.deepEqual(r.corpo.cordas.sort(), Object.keys(CORDAS).sort());
  });

  test('consulta vai de "na fila" a "concluído" sem confirmação', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.consulta'));
    assert.equal(r.status, 201);
    assert.equal(r.corpo.estado, 'na_fila');
    assert.equal(r.corpo.comando, undefined, 'o comando (com dados do produtor) não volta pela API');
    const p = await s.esperarEstado(r.corpo.id, ['concluido', 'falhou']);
    assert.equal(p.estado, 'concluido');
    assert.equal(p.resultado.mensagem, 'Lido.');
  });

  test('anexo: o app sobe o arquivo, o pedido leva o id e a função recebe o caminho', async () => {
    const ruim = await s.pedir('POST', '/anexos', { nome: 'x.exe', base64: Buffer.from('MZ').toString('base64') });
    assert.equal(ruim.status, 400);
    const up = await s.pedir('POST', '/anexos', { nome: 'consulta.txt', base64: Buffer.from('texto da consulta').toString('base64') });
    assert.equal(up.status, 201);
    assert.match(up.corpo.id, /^a_[a-z0-9]+$/);
    const r = await s.pedir('POST', '/comandos', s.comando('teste.anexo', { risco: 'consulta', entradas: { arquivo: up.corpo.id } }));
    const p = await s.esperarEstado(r.corpo.id, ['concluido', 'falhou']);
    assert.equal(p.resultado.mensagem, 'Anexo: consulta.txt texto da consulta');
  });

  test('tela pública (DAE, validar documento): o app manda produtor null e roda sem entrar no SIARE', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.publica', { produtor: null, risco: 'consulta' }));
    const p = await s.esperarEstado(r.corpo.id, ['concluido', 'falhou']);
    assert.equal(p.estado, 'concluido', p.erro);
    assert.equal(p.resultado.mensagem, 'Tela pública lida.');
    assert.ok(!p.log.some((l) => /Entrando no SIARE/.test(l)));
  });

  test('nota: para antes do passo sem volta, mostra a prévia e só segue com /confirmar', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.nota'));
    let p = await s.esperarEstado(r.corpo.id, ['aguardando_confirmacao']);
    assert.deepEqual(p.previa, [['Total da nota', 'R$ 10,00']]);
    await dormir(80);
    assert.equal((await s.pedir('GET', '/comandos/' + p.id)).corpo.estado, 'aguardando_confirmacao', 'sem confirmação, não anda');
    const c = await s.pedir('POST', `/comandos/${p.id}/confirmar`);
    assert.equal(c.status, 200);
    p = await s.esperarEstado(p.id, ['concluido']);
    assert.equal(p.resultado.protocolo, 'P-123');
    const de_novo = await s.pedir('POST', `/comandos/${p.id}/confirmar`);
    assert.equal(de_novo.status, 409, 'confirmar duas vezes não faz nada');
  });

  test('desistir enquanto aguarda a confirmação: nada é enviado', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.nota'));
    await s.esperarEstado(r.corpo.id, ['aguardando_confirmacao']);
    const d = await s.pedir('POST', `/comandos/${r.corpo.id}/desistir`);
    assert.equal(d.status, 200);
    const p = await s.esperarEstado(r.corpo.id, ['desistido']);
    assert.equal(p.resultado, undefined);
    assert.match(p.log.join(' '), /Nada foi enviado/);
  });

  test('sem protocolo depois da confirmação vai para "verificar"; erro depois também', async () => {
    for (const processo of ['teste.semprotocolo', 'teste.errodepois']) {
      const r = await s.pedir('POST', '/comandos', s.comando(processo));
      await s.esperarEstado(r.corpo.id, ['aguardando_confirmacao']);
      await s.pedir('POST', `/comandos/${r.corpo.id}/confirmar`);
      const p = await s.esperarEstado(r.corpo.id, ['verificar', 'concluido', 'falhou']);
      assert.equal(p.estado, 'verificar', processo);
    }
  });

  test('sem protocolo, mas a tela confirmou (confirmado): conclui; sem prova: verificar', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.confirmado'));
    await s.esperarEstado(r.corpo.id, ['aguardando_confirmacao']);
    await s.pedir('POST', `/comandos/${r.corpo.id}/confirmar`);
    const p = await s.esperarEstado(r.corpo.id, ['concluido', 'verificar', 'falhou']);
    assert.equal(p.estado, 'concluido');
  });

  test('pedido igual (mesma chave) devolve o que já existe', async () => {
    const cmd = s.comando('teste.consulta', { chaveIdempotencia: 'mesma-chave' });
    const a = await s.pedir('POST', '/comandos', cmd);
    const b = await s.pedir('POST', '/comandos', cmd);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.corpo.id, b.corpo.id);
  });

  test('função que ainda não é executada falha na hora, sem abrir nada', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('nfa.emitir'));
    const p = await s.esperarEstado(r.corpo.id, ['falhou']);
    assert.match(p.erro, /chega em breve/);
  });

  test('acesso recusado no SIARE: falha, sem tentar de novo', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.consulta', { produtor: { ...PRODUTOR, ie: '9999999999999' } }));
    const p = await s.esperarEstado(r.corpo.id, ['falhou']);
    assert.match(p.erro, /recusou/);
  });

  test('a fila anda pela ordem de chegada, um por vez', async () => {
    execucoes.length = 0;
    const a = await s.pedir('POST', '/comandos', s.comando('teste.consulta'));
    const b = await s.pedir('POST', '/comandos', s.comando('teste.nota'));
    const c = await s.pedir('POST', '/comandos', s.comando('teste.consulta'));
    await s.esperarEstado(b.corpo.id, ['aguardando_confirmacao']);
    assert.equal((await s.pedir('GET', '/comandos/' + c.corpo.id)).corpo.estado, 'na_fila', 'o terceiro espera o segundo');
    await s.pedir('POST', `/comandos/${b.corpo.id}/confirmar`);
    await s.esperarEstado(c.corpo.id, ['concluido']);
    assert.deepEqual(execucoes, ['consulta', 'nota', 'consulta']);
    assert.equal((await s.pedir('GET', '/comandos/' + a.corpo.id)).corpo.estado, 'concluido');
  });

  test('nenhuma mensagem do servidor fala em robô', async () => {
    const todos = (await s.pedir('GET', '/comandos')).corpo;
    const texto = JSON.stringify(todos.map((p) => [p.etapa, p.erro, p.log, p.resultado]));
    assert.doesNotMatch(texto, /rob[oô]/i);
  });

  test('a senha nunca aparece em pedido, log ou arquivo de dados', async () => {
    const todos = JSON.stringify((await s.pedir('GET', '/comandos')).corpo);
    assert.doesNotMatch(todos, /nao-usada-nos-testes/);
    assert.doesNotMatch(readFileSync(join(s.cfg.dados, 'pedidos.json'), 'utf8'), /nao-usada-nos-testes/);
  });
});

describe('servidor na internet (com código de acesso)', () => {
  let s;
  before(async () => { s = await subir(configTeste({ naNuvem: true, codigoAcesso: 'codigo-de-teste-123', segredoSessao: 'segredo-de-teste' })); });
  after(async () => { await s.fechar(); });

  test('sem código: o aplicativo abre, mas a API e os arquivos não', async () => {
    assert.equal((await s.pedir('GET', '/')).status, 200);
    assert.equal((await s.pedir('GET', '/health')).status, 200);
    assert.equal((await s.pedir('GET', '/cordas')).status, 401);
    assert.equal((await s.pedir('GET', '/comandos')).status, 401);
    assert.equal((await s.pedir('GET', '/evidencias/x/01.png')).status, 401);
    assert.equal((await s.pedir('POST', '/comandos', s.comando('teste.consulta'))).status, 401);
    assert.equal((await s.pedir('GET', '/cadastros/destinatarios')).status, 401);
    assert.equal((await s.pedir('POST', '/cadastros/notas', { itens: [] })).status, 401);
  });

  test('código errado é recusado; depois de 5 erros, espera', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await s.pedir('POST', '/sessao', { codigo: 'errado' }, { 'x-forwarded-for': '10.0.0.9' })).status, 401);
    assert.equal((await s.pedir('POST', '/sessao', { codigo: 'codigo-de-teste-123' }, { 'x-forwarded-for': '10.0.0.9' })).status, 429);
  });

  test('código certo: cookie HttpOnly e Strict, e a API abre', async () => {
    const r = await fetch(s.base + '/sessao', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ codigo: 'codigo-de-teste-123' }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const ok = await s.pedir('POST', '/sessao', { codigo: 'codigo-de-teste-123' });
    assert.equal(ok.status, 200);
    assert.equal((await s.pedir('GET', '/cordas')).status, 200);
  });

  test('cookie adulterado não vale', async () => {
    const r = await fetch(s.base + '/cordas', { headers: { cookie: 'af_sessao=99999999999999.assinatura-falsa' } });
    assert.equal(r.status, 401);
  });

  test('na internet, outra origem (mesmo localhost) não recebe CORS', async () => {
    const r = await fetch(s.base + '/health', { headers: { origin: 'http://localhost:5182' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
});

describe('cofre pela API', () => {
  test('POST /credenciais guarda, a consulta usa a senha e a API nunca a devolve', async () => {
    let usada = null;
    const s = await subir(configTeste({ credenciais: new Map() }), {
      entrarNoSiare: async (_page, produtor, { credencial, etapa }) => {
        etapa('Entrando no SIARE');
        usada = credencial; // o que o cofre entregou ao login
        if (!credencial) throw new Error('A senha deste produtor não está guardada no servidor.');
      },
    });
    try {
      // sem senha guardada, a consulta falha pedindo a senha
      const r0 = await s.pedir('POST', '/comandos', s.comando('teste.consulta'));
      const p0 = await s.esperarEstado(r0.corpo.id, ['falhou']);
      assert.match(p0.erro, /não está guardada/);

      const g = await s.pedir('POST', '/credenciais', { ie: '0000000000272', cpf: '11144477735', senha: 'senha-do-siare-real' });
      assert.equal(g.status, 200);
      assert.doesNotMatch(JSON.stringify(g.corpo), /senha-do-siare-real/);

      const lista = await s.pedir('GET', '/credenciais');
      assert.equal(lista.corpo.credenciais[0].ie, '0000000000272');
      assert.doesNotMatch(JSON.stringify(lista.corpo), /senha-do-siare-real/);

      const r = await s.pedir('POST', '/comandos', s.comando('teste.consulta', { produtor: { ...PRODUTOR, ie: '0000000000272' } }));
      await s.esperarEstado(r.corpo.id, ['concluido']);
      assert.equal(usada.senha, 'senha-do-siare-real');

      // a senha não aparece em nenhum pedido guardado
      assert.doesNotMatch(JSON.stringify((await s.pedir('GET', '/comandos')).corpo), /senha-do-siare-real/);

      await s.pedir('POST', '/credenciais/0000000000272/remover');
      assert.equal((await s.pedir('GET', '/credenciais')).corpo.credenciais.length, 0);
    } finally {
      await s.fechar();
    }
  });

  test('na internet, /credenciais exige o código de acesso', async () => {
    const s = await subir(configTeste({ naNuvem: true, codigoAcesso: 'codigo-de-teste-123', credenciais: new Map() }));
    try {
      assert.equal((await s.pedir('GET', '/credenciais')).status, 401);
      assert.equal((await s.pedir('POST', '/credenciais', { ie: '0000000000272', cpf: '11144477735', senha: 'x' })).status, 401);
    } finally {
      await s.fechar();
    }
  });
});

describe('reinício do servidor', () => {
  test('quem estava no meio não é repetido sozinho', async () => {
    const cfg = configTeste();
    const base = { titulo: 't', risco: 'irreversivel', produtor: PRODUTOR, comando: {}, log: [], criadoEm: new Date().toISOString() };
    writeFileSync(join(cfg.dados, 'pedidos.json'), JSON.stringify([
      { ...base, id: 'a', processo: 'teste.nota', estado: 'finalizando' },
      { ...base, id: 'b', processo: 'teste.nota', estado: 'em_execucao' },
      { ...base, id: 'c', processo: 'teste.nota', estado: 'aguardando_confirmacao' },
    ]));
    const app = criarServidor(cfg, { cordas: CORDAS });
    const estados = Object.fromEntries(app.pedidos().map((p) => [p.id, p.estado]));
    assert.deepEqual(estados, { a: 'verificar', b: 'falhou', c: 'desistido' });
  });
});

describe('configuração', () => {
  test('na internet, sem CODIGO_ACESSO o servidor não sobe', () => {
    assert.throws(() => lerConfig({ RENDER: 'true' }), /CODIGO_ACESSO/);
  });
  test('na internet: 0.0.0.0, porta do Render e sem janela', () => {
    const c = lerConfig({ RENDER: 'true', CODIGO_ACESSO: 'um-codigo-longo', PORT: '10000' });
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.porta, 10000);
    assert.equal(c.semJanela, true);
  });
  test('no PC: só 127.0.0.1, porta 5181, com janela', () => {
    const c = lerConfig({});
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.porta, 5181);
    assert.equal(c.semJanela, false);
  });
  test('credenciais: lidas por IE e erros sem mostrar a senha', () => {
    const m = lerCredenciais({ SIARE_CREDENCIAIS: JSON.stringify({ '0000000000191': { cpf: '529.982.247-25', senha: 'segredo-x' } }) });
    assert.equal(m.get('0000000000191').cpf, '52998224725');
    assert.throws(() => lerCredenciais({ SIARE_CREDENCIAIS: '{"0000000000191": {"cpf": "1", "senha": "segredo-y"}}' }), (e) => !/segredo-y/.test(e.message));
    assert.throws(() => lerCredenciais({ SIARE_CREDENCIAIS: 'segredo-z não é json' }), (e) => !/segredo-z/.test(e.message));
  });
  test('PING_SEGREDO curto não sobe; o sorteado pela PONTE (24 letras) sobe', () => {
    assert.throws(() => lerConfig({ PING_SEGREDO: 'curto' }), /PING_SEGREDO/);
    assert.equal(lerConfig({ PING_SEGREDO: 'AbCdEfGhJkMnPqRsTuVwXyZ2' }).segredoDoPing, 'AbCdEfGhJkMnPqRsTuVwXyZ2');
  });
});

describe('cadastros (destinatários, romaneios e notas salvas)', () => {
  let s;
  before(async () => { s = await subir(configTeste()); });
  after(async () => { await s.fechar(); });

  test('dois aparelhos: junta, vale a versão mais nova e o apagado some nos dois', async () => {
    const t1 = '2026-10-15T10:00:00.000Z';
    const t2 = '2026-10-15T11:00:00.000Z';
    // celular manda dois destinatários
    let r = await s.pedir('POST', '/cadastros/destinatarios', { itens: [{ id: 'de_a', nome: 'A', atualizadoEm: t1 }, { id: 'de_b', nome: 'B', atualizadoEm: t1 }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo.itens.map((x) => x.id).sort(), ['de_a', 'de_b']);
    // PC (que não tinha nada) muda A e apaga B mais tarde; manda também um item velho de A, que perde
    r = await s.pedir('POST', '/cadastros/destinatarios', { itens: [{ id: 'de_a', nome: 'A2', atualizadoEm: t2 }, { id: 'de_b', atualizadoEm: t2, removido: true }] });
    assert.deepEqual(r.corpo.itens, [{ id: 'de_a', nome: 'A2', atualizadoEm: t2 }, { id: 'de_b', atualizadoEm: t2, removido: true }]);
    r = await s.pedir('POST', '/cadastros/destinatarios', { itens: [{ id: 'de_a', nome: 'A velho', atualizadoEm: t1 }, { id: 'de_b', nome: 'B', atualizadoEm: t1 }] });
    assert.equal(r.corpo.itens.find((x) => x.id === 'de_a').nome, 'A2');
    assert.equal(r.corpo.itens.find((x) => x.id === 'de_b').removido, true);
    // ficou gravado em disco
    assert.equal((await s.pedir('GET', '/cadastros/destinatarios')).corpo.itens.length, 2);
  });

  test('só os três tipos; item sem id válido ou sem data é ignorado', async () => {
    assert.equal((await s.pedir('GET', '/cadastros/senhas')).status, 404);
    assert.equal((await s.pedir('POST', '/cadastros/notas', { nada: 1 })).status, 400);
    const r = await s.pedir('POST', '/cadastros/notas', { itens: [{ id: '../x', atualizadoEm: '2026-10-15T10:00:00Z' }, { id: 'ns_1' }, { id: 'ns_2', atualizadoEm: '2026-10-15T10:00:00Z', estado: { v: {} } }] });
    assert.deepEqual(r.corpo.itens.map((x) => x.id), ['ns_2']);
  });
});

describe('robô de um cliente da PONTE (kit AGRO FÁCIL)', () => {
  const SEGREDO = 'segredo-do-site-de-teste-com-mais-de-32-caracteres';
  const COM_SEGREDO = { 'x-agro-facil-segredo': SEGREDO };
  // Com espaço de propósito: a PONTE monta a URL com encodeURIComponent.
  const PING = 'segredo do ping de teste';
  const naPonte = [];
  let credencialUsada = null;
  // A PONTE de mentira: responde como a rota POST /api/campo/robo/credencial.
  const ponteFalsa = async (url, init) => {
    naPonte.push({ url, headers: init.headers, corpo: JSON.parse(init.body) });
    const { ie } = JSON.parse(init.body);
    if (ie === '8888888888888') {
      return new Response(JSON.stringify({ erro: 'Termo de autorização deste produtor está aguardando assinatura.' }), { status: 409 });
    }
    return new Response(JSON.stringify({ credencial: { ie, cpf: '11144477735', senha: 'senha-que-veio-da-ponte', tipoAcesso: 'produtor' } }), { status: 200 });
  };
  let s;
  before(async () => {
    s = await subir(configTeste({ naNuvem: true, segredoDoSite: SEGREDO, segredoDoPing: PING, soApi: true }), {
      cofre: criarCofreDaPonte({ url: 'https://ponte.exemplo/', chave: 'chave-do-robo-de-teste', buscar: ponteFalsa }),
      entrarNoSiare: async (_page, _produtor, { credencial, etapa }) => { credencialUsada = credencial; etapa('Entrando no SIARE'); },
    });
  });
  after(async () => { await s.fechar(); });

  test('sem o segredo do site a API não abre, nem para quem acha o endereço do Render', async () => {
    assert.equal((await s.pedir('GET', '/cordas')).status, 401);
    assert.equal((await s.pedir('GET', '/cordas', undefined, { 'x-agro-facil-segredo': 'chute' })).status, 401);
    assert.equal((await s.pedir('GET', '/cordas', undefined, COM_SEGREDO)).status, 200);
    assert.equal((await s.pedir('GET', '/health')).status, 200);
  });

  test('o "Acordar agora" da PONTE responde ao segredo do ping, e só a ele', async () => {
    const certo = await s.pedir('GET', '/acordar/' + encodeURIComponent(PING));
    assert.equal(certo.status, 202);
    assert.equal(certo.corpo.ok, true);
    assert.equal((await s.pedir('GET', '/acordar/chute')).status, 404);
    assert.equal((await s.pedir('GET', '/acordar/' + encodeURIComponent(PING) + 'x')).status, 404);
    assert.equal((await s.pedir('GET', '/acordar/%E0%A4%A')).status, 404);
    // Acordar não abre a API.
    assert.equal((await s.pedir('GET', '/cordas')).status, 401);
  });

  test('a senha do SIARE vem da PONTE na hora do login, com a chave do robô, e não fica aqui', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.consulta'), COM_SEGREDO);
    const p = await (async () => {
      for (let i = 0; i < 200; i++) {
        const x = await s.pedir('GET', '/comandos/' + r.corpo.id, undefined, COM_SEGREDO);
        if (['concluido', 'falhou'].includes(x.corpo.estado)) return x.corpo;
        await dormir(20);
      }
      throw new Error('o pedido não terminou');
    })();
    assert.equal(p.estado, 'concluido', p.erro);
    assert.equal(credencialUsada.senha, 'senha-que-veio-da-ponte');
    const ultimo = naPonte.at(-1);
    assert.equal(ultimo.url, 'https://ponte.exemplo/api/campo/robo/credencial');
    assert.equal(ultimo.headers['x-api-key'], 'chave-do-robo-de-teste');
    assert.deepEqual(ultimo.corpo, { ie: '0000000000191' });
    assert.ok(!readFileSync(join(s.cfg.dados, 'pedidos.json'), 'utf8').includes('senha-que-veio-da-ponte'));
  });

  test('a recusa da PONTE (termo pendente, sem senha) vira o motivo do pedido, e nada é enviado', async () => {
    const r = await s.pedir('POST', '/comandos', s.comando('teste.consulta', { produtor: { ...PRODUTOR, ie: '8888888888888' } }), COM_SEGREDO);
    let p;
    for (let i = 0; i < 200; i++) {
      p = (await s.pedir('GET', '/comandos/' + r.corpo.id, undefined, COM_SEGREDO)).corpo;
      if (['concluido', 'falhou'].includes(p.estado)) break;
      await dormir(20);
    }
    assert.equal(p.estado, 'falhou');
    assert.match(p.erro, /aguardando assinatura/);
  });

  test('não serve telas e não aceita senha do SIARE: as duas coisas moram no site e na PONTE', async () => {
    const tela = await s.pedir('GET', '/', undefined, COM_SEGREDO);
    assert.equal(tela.status, 404);
    assert.match(tela.corpo.erro, /robô do AGRO FÁCIL/);
    const senha = await s.pedir('POST', '/credenciais', { ie: '0000000000191', cpf: '52998224725', senha: 'x' }, COM_SEGREDO);
    assert.equal(senha.status, 409);
    assert.equal((await s.pedir('GET', '/credenciais', undefined, COM_SEGREDO)).corpo.naPonte, true);
  });
});
