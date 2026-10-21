// Servidor do AGRO FÁCIL. Implementa o CONTRATO-API.md:
//   GET  /health                 está no ar? (público)
//   GET  /acordar/:segredo       o "Acordar agora" da PONTE (público, só com PING_SEGREDO)
//   POST /sessao {codigo}        entra com o código de acesso (público)
//   GET  /cordas                 o que já é executado no SIARE
//   POST /comandos               cria o pedido (ou devolve o igual que já existe)
//   GET  /comandos/:id           estado do pedido
//   POST /comandos/:id/confirmar a pessoa conferiu: segue para o passo sem volta
//   POST /comandos/:id/desistir  para tudo; nada vai para a Fazenda
// Também serve o aplicativo (manete-web/dist), as evidências e os arquivos.
//
// Uma execução por vez, pela ordem de chegada, com pausa entre os logins; um
// navegador novo por pedido.
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { criarCadastros, MAX_ITENS, TIPOS_CADASTRO } from './cadastros.mjs';
import { extname, join, normalize, sep } from 'node:path';
import { chaveLocal, criarCofre } from './cofre.mjs';
import { criarCofreDaPonte } from './cofre-ponte.mjs';
import { CORDAS as CORDAS_REAIS, motivoSemCorda } from './cordas.mjs';
import { abrirNavegador as abrirReal, entrarNoSiare as entrarReal, naTelaDeLogin, tratarDialogos } from './navegador.mjs';
import { criarSessoes } from './sessao.mjs';

const ATIVOS = ['na_fila', 'em_execucao', 'aguardando_confirmacao', 'finalizando'];
const hora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: process.env.TZ || 'America/Sao_Paulo' });

class Desistencia extends Error {}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

/**
 * Monta o servidor. `deps` existe para os testes trocarem o SIARE e o
 * navegador por imitações; em produção ficam os reais.
 */
export function criarServidor(cfg, deps = {}) {
  const CORDAS = deps.cordas || CORDAS_REAIS;
  const abrirNavegador = deps.abrirNavegador || (() => abrirReal({ semJanela: cfg.semJanela, executavel: cfg.navegador }));
  const entrarNoSiare = deps.entrarNoSiare || entrarReal;
  const sessoes = criarSessoes(cfg);
  const DADOS = cfg.dados;
  const ARQ_PEDIDOS = join(DADOS, 'pedidos.json');
  const cadastros = criarCadastros(DADOS);
  mkdirSync(join(DADOS, 'evidencias'), { recursive: true });
  mkdirSync(join(DADOS, 'arquivos'), { recursive: true });
  mkdirSync(join(DADOS, 'anexos'), { recursive: true });
  // Anexos (ex.: o arquivo da consulta à Fazenda): o app sobe antes (POST /anexos)
  // e o pedido leva só o id; a corda pega o caminho do arquivo por `anexo(id)`.
  const ANEXO_TIPOS = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
  const ANEXO_MAX_BYTES = 8 * 1024 * 1024;
  const anexo = (id) => {
    if (!/^a_[a-z0-9]+$/.test(String(id || ''))) return null;
    try {
      const meta = JSON.parse(readFileSync(join(DADOS, 'anexos', id + '.json'), 'utf8'));
      const caminho = join(DADOS, 'anexos', id + '.' + meta.ext);
      return existsSync(caminho) ? { caminho, nome: meta.nome } : null;
    } catch { return null; }
  };
  // Cofre das senhas do SIARE: guardadas pelo cadastro do app (cifradas) e as
  // do segredo SIARE_CREDENCIAIS como base. O login usa cofre.credencial(ie).
  // Robô de um cliente da PONTE: a senha vem do cofre dela, a cada login.
  const cofre = deps.cofre
    || (cfg.ponteUrl ? criarCofreDaPonte({ url: cfg.ponteUrl, chave: cfg.ponteChaveRobo })
      : criarCofre({ arquivo: join(DADOS, 'credenciais.json'), segredo: cfg.segredoCredenciais || chaveLocal(DADOS), base: cfg.credenciais }));

  // ---------------- pedidos ----------------
  let pedidos = [];
  try { pedidos = JSON.parse(readFileSync(ARQ_PEDIDOS, 'utf8')); } catch { pedidos = []; }
  // O servidor caiu no meio: o navegador daquela execução sumiu junto.
  for (const p of pedidos) {
    if (p.estado === 'finalizando') {
      p.estado = 'verificar';
      p.log.push(hora() + ' O servidor reiniciou durante o envio à Fazenda. Confira no SIARE antes de repetir.');
    } else if (p.estado === 'em_execucao') {
      p.estado = 'falhou';
      p.erro = 'O servidor reiniciou antes do passo sem volta. Nada foi enviado.';
      p.log.push(hora() + ' ' + p.erro);
    } else if (p.estado === 'aguardando_confirmacao') {
      p.estado = 'desistido';
      p.log.push(hora() + ' O servidor reiniciou antes da sua confirmação. Nada foi enviado.');
    }
  }
  const salvar = () => {
    try { writeFileSync(ARQ_PEDIDOS, JSON.stringify(pedidos, null, 1)); } catch (e) { console.error('não gravei pedidos.json:', e.message); }
  };
  salvar();
  const publico = (p) => { const { comando, cancelado, ...resto } = p; return resto; };
  const esperas = new Map(); // id → { seguir, parar } enquanto aguarda a confirmação

  // ---------------- fila: uma execução por vez, pela ordem de chegada ----------------
  let rodando = false;
  let fimDoUltimoLogin = 0;
  async function proximo() {
    if (rodando) return;
    const p = pedidos.find((x) => x.estado === 'na_fila');
    if (!p) return;
    rodando = true;
    try {
      const falta = fimDoUltimoLogin + cfg.pausaEntreLoginsMs - Date.now();
      if (falta > 0) {
        p.etapa = 'Na fila';
        await new Promise((r) => setTimeout(r, falta));
      }
      if (p.estado === 'na_fila') await executar(p);
    } finally {
      fimDoUltimoLogin = Date.now();
      rodando = false;
      setImmediate(proximo);
    }
  }

  async function executar(p) {
    const registrar = (msg) => { p.log.push(hora() + ' ' + msg); salvar(); };
    const etapa = (nome) => { p.etapa = nome; registrar(nome); };
    const corda = CORDAS[p.processo];
    if (!corda) { p.estado = 'falhou'; p.erro = motivoSemCorda(p.processo); registrar(p.erro); return; }
    // Telas públicas (DAE, validar documento) não entram no SIARE: o app manda produtor null.
    if (!corda.semLogin && (!p.produtor || !p.produtor.ie)) { p.estado = 'falhou'; p.erro = 'O pedido não traz o produtor.'; registrar(p.erro); return; }

    p.estado = 'em_execucao';
    salvar();
    let sessao = null;
    let n = 0;
    let pausou = false;
    let confirmado = false;
    const pastaEv = join(DADOS, 'evidencias', p.id);
    mkdirSync(pastaEv, { recursive: true });
    const evidencia = async (nome) => {
      try {
        // Nunca guarda print da tela de login (tem o campo da senha).
        if (await naTelaDeLogin(sessao.page)) return;
        const base = `${String(++n).padStart(2, '0')}-${nome.replace(/[^\w-]+/g, '_')}`;
        await sessao.page.screenshot({ path: join(pastaEv, base + '.png'), fullPage: true });
        const html = await sessao.page.content().catch(() => '');
        if (html) writeFileSync(join(pastaEv, base + '.html'), html);
        (p.evidencias = p.evidencias || []).push({ etapa: nome, print: `/evidencias/${p.id}/${base}.png`, ...(html ? { html: `/evidencias/${p.id}/${base}.html` } : {}) });
        salvar();
      } catch { /* evidência nunca derruba o pedido */ }
    };
    const guardarArquivo = async (nome, bytes) => {
      const arq = `${p.id}-${nome}`;
      writeFileSync(join(DADOS, 'arquivos', arq), bytes);
      return `/arquivos/${arq}`;
    };
    // Para antes do passo sem volta e espera a pessoa conferir no aplicativo.
    const pausar = (previa) =>
      new Promise((seguir, parar) => {
        if (p.cancelado) return parar(new Desistencia('Você desistiu. Nada foi enviado.'));
        pausou = true;
        if (Array.isArray(previa) && previa.length) p.previa = previa;
        p.estado = 'aguardando_confirmacao';
        etapa('Aguardando sua confirmação');
        const relogio = setTimeout(() => {
          esperas.delete(p.id);
          parar(new Desistencia('O tempo para confirmar acabou. Nada foi enviado.'));
        }, cfg.tetoConfirmacaoMs);
        esperas.set(p.id, {
          seguir: () => { clearTimeout(relogio); esperas.delete(p.id); confirmado = true; p.estado = 'finalizando'; etapa('Enviando à Fazenda'); seguir(); },
          parar: (motivo) => { clearTimeout(relogio); esperas.delete(p.id); parar(new Desistencia(motivo)); },
        });
      });

    try {
      etapa('Abrindo o navegador');
      sessao = await abrirNavegador();
      tratarDialogos(sessao.page, registrar, () => confirmado);
      // Telas públicas (ex.: DAE) não têm login: a corda marca corda.semLogin.
      if (!corda.semLogin) {
        await entrarNoSiare(sessao.page, p.produtor, {
          // `await`: o cofre da PONTE pergunta pela rede; o local responde na hora.
          credencial: await cofre.credencial(p.produtor.ie),
          semJanela: cfg.semJanela,
          etapa,
          cancelado: () => !!p.cancelado,
          tetoMs: cfg.tetoLoginAssistidoMs,
        });
        registrar('Entrada conferida: a IE da tela é a do pedido.');
        await evidencia('entrada');
      }
      if (p.cancelado) throw new Desistencia('Você desistiu. Nada foi enviado.');
      const resultado = await corda({ page: sessao.page, entradas: p.comando.entradas || {}, produtor: p.produtor, etapa, evidencia, guardarArquivo, pausar, previaApp: p.previa || null, anexo });
      p.resultado = resultado || {};
      p.etapa = '';
      // Passo sem volta sem protocolo: ninguém sabe se chegou. Nunca repete sozinho.
      // `confirmado`: a corda leu na tela que deu certo (pedidos que não geram protocolo).
      if (pausou && !p.resultado.protocolo && !p.resultado.numero && !p.resultado.confirmado) {
        p.estado = 'verificar';
        registrar('Sem protocolo na resposta do SIARE. Confira no SIARE antes de repetir.');
      } else {
        p.estado = 'concluido';
        registrar('Concluído.');
      }
    } catch (e) {
      if (sessao && !(e instanceof Desistencia)) await evidencia('erro');
      if (e instanceof Desistencia || (p.cancelado && !confirmado)) {
        p.estado = 'desistido';
        registrar(e.message || 'Desistido. Nada foi enviado.');
      } else if (confirmado) {
        // Já confirmado: o envio pode ter chegado à Fazenda.
        p.estado = 'verificar';
        p.erro = e.message;
        registrar('Erro depois da confirmação: ' + e.message + ' Confira no SIARE antes de repetir.');
      } else {
        p.estado = 'falhou';
        p.erro = e.message;
        registrar('Não deu certo: ' + e.message);
      }
      p.etapa = '';
    } finally {
      esperas.delete(p.id);
      if (sessao) await sessao.fechar();
      salvar();
    }
  }

  // ---------------- HTTP ----------------
  const ORIGENS_LOCAIS = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  function cors(req, res) {
    const origem = req.headers.origin || '';
    // No PC, o aplicativo em desenvolvimento roda em outra porta da mesma máquina.
    if ((!cfg.naNuvem && ORIGENS_LOCAIS.test(origem)) || cfg.origens.includes(origem)) {
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
  }
  function seguranca(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  const json = (res, status, corpo, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(corpo));
  };
  const lerCorpo = (req, maximo = 2e6) =>
    new Promise((ok, falha) => {
      let s = '';
      req.on('data', (c) => { s += c; if (s.length > maximo) { falha(new Error('corpo grande demais')); req.destroy(); } });
      req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { falha(new Error('JSON inválido')); } });
    });
  function arquivo(res, raiz, relativo, imutavel = false) {
    const alvo = normalize(join(raiz, relativo));
    if (!alvo.startsWith(raiz + sep) && alvo !== raiz) return json(res, 403, { erro: 'fora da pasta' });
    if (!existsSync(alvo) || !statSync(alvo).isFile()) return json(res, 404, { erro: 'não existe' });
    const tipo = TIPOS[extname(alvo)] || 'application/octet-stream';
    const cabecalhos = { 'Content-Type': tipo, 'Cache-Control': imutavel ? 'public, max-age=31536000, immutable' : 'no-store' };
    if (tipo.startsWith('text/html')) {
      cabecalhos['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
    }
    // Evidência em HTML é a tela do SIARE: abre como texto, nunca como página daqui.
    if (raiz.endsWith('evidencias') && tipo.startsWith('text/html')) cabecalhos['Content-Type'] = 'text/plain; charset=utf-8';
    res.writeHead(200, cabecalhos);
    createReadStream(alvo).pipe(res);
  }

  const servidor = createServer(async (req, res) => {
    cors(req, res);
    seguranca(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // POST só com JSON: obriga o navegador a pedir licença (CORS) antes, e uma
    // página de fora não consegue mandar comando escondido para cá.
    if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
      return json(res, 415, { erro: 'use Content-Type: application/json' });
    }
    const url = new URL(req.url, 'http://localhost');
    const partes = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, versao: 1, cordas: Object.keys(CORDAS).length, fila: pedidos.filter((p) => ATIVOS.includes(p.estado)).length });
      }
      // O "Acordar agora" do painel da PONTE. Público como o /health, mas só
      // responde ao segredo certo: é o que diz ao painel que o endereço gravado
      // lá é ESTE robô, e não um serviço qualquer no ar. O caminho é decodificado
      // porque a PONTE monta a URL com encodeURIComponent. Sem PING_SEGREDO, a
      // rota não existe.
      if (req.method === 'GET' && partes[0] === 'acordar' && partes.length === 2 && cfg.segredoDoPing) {
        let pedido = '';
        try { pedido = decodeURIComponent(partes[1]); } catch { /* percentagem malformada não é segredo */ }
        const a = Buffer.from(pedido);
        const b = Buffer.from(cfg.segredoDoPing);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          return json(res, 202, { ok: true, fila: pedidos.filter((p) => ATIVOS.includes(p.estado)).length });
        }
        return json(res, 404, { erro: 'não encontrado' });
      }
      if (partes[0] === 'sessao' && req.method === 'POST') {
        if (partes[1] === 'sair') return json(res, 200, { ok: true }, { 'Set-Cookie': sessoes.sair() });
        const { codigo } = await lerCorpo(req);
        const r = sessoes.entrar(req, typeof codigo === 'string' ? codigo : '');
        if (r.erro) return json(res, r.status, { erro: r.erro === 'muitas' ? 'Muitas tentativas. Espere 10 minutos.' : 'Código errado.' });
        return json(res, 200, { ok: true }, { 'Set-Cookie': r.cookie });
      }
      const protegida = ['cordas', 'comandos', 'evidencias', 'arquivos', 'credenciais', 'anexos', 'cadastros'].includes(partes[0]);
      if (protegida && !sessoes.valida(req)) return json(res, 401, { erro: 'Digite o código de acesso.' });

      // Senhas do SIARE: guardadas e usadas no servidor. A senha nunca é devolvida.
      // Anexo: {nome, base64} → guarda e devolve o id que vai no pedido. Nunca é servido de volta.
      if (partes[0] === 'anexos' && req.method === 'POST' && partes.length === 1) {
        const a = await lerCorpo(req, Math.ceil(ANEXO_MAX_BYTES * 1.4) + 4096);
        const nome = String(a.nome || '').replace(/[^\w.\- ]+/g, '_').slice(-80);
        const ext = (nome.split('.').pop() || '').toLowerCase();
        if (!ANEXO_TIPOS[ext]) return json(res, 400, { erro: 'Envie PDF, imagem, Word ou texto.' });
        const bytes = Buffer.from(String(a.base64 || '').replace(/^data:[^,]*,/, ''), 'base64');
        if (!bytes.length) return json(res, 400, { erro: 'Arquivo vazio.' });
        if (bytes.length > ANEXO_MAX_BYTES) return json(res, 400, { erro: 'Arquivo maior que 8 MB.' });
        const id = 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        writeFileSync(join(DADOS, 'anexos', id + '.' + ext), bytes);
        writeFileSync(join(DADOS, 'anexos', id + '.json'), JSON.stringify({ nome, ext, tamanho: bytes.length, em: new Date().toISOString() }));
        return json(res, 201, { id, nome, tamanho: bytes.length });
      }
      // Destinatários, romaneios e notas salvas: o app manda o que tem e recebe tudo, já juntado.
      if (partes[0] === 'cadastros') {
        const tipo = partes[1];
        if (partes.length !== 2 || !TIPOS_CADASTRO.includes(tipo)) return json(res, 404, { erro: 'rota não existe' });
        if (req.method === 'GET') return json(res, 200, { itens: cadastros.listar(tipo) });
        if (req.method === 'POST') {
          const c = await lerCorpo(req, 8e6);
          if (!Array.isArray(c.itens) || c.itens.length > MAX_ITENS) return json(res, 400, { erro: 'Mande {"itens": [...]}.' });
          return json(res, 200, { itens: cadastros.sincronizar(tipo, c.itens) });
        }
        return json(res, 404, { erro: 'rota não existe' });
      }
      if (partes[0] === 'credenciais') {
        if (req.method === 'GET' && partes.length === 1) return json(res, 200, { credenciais: cofre.lista(), naPonte: !!cofre.daPonte });
        // Com o cofre da PONTE a senha é cadastrada no painel dela, nunca aqui.
        if (cofre.daPonte) return json(res, 409, { erro: 'A senha do SIARE de cada produtor é cadastrada no painel da PONTE.' });
        if (req.method === 'POST' && partes.length === 1) {
          const c = await lerCorpo(req);
          try {
            cofre.guardar({ ie: c.ie, cpf: c.cpf, senha: c.senha, dominio: c.dominio });
          } catch (e) {
            return json(res, 400, { erro: e.message });
          }
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && partes[2] === 'remover') {
          cofre.remover(partes[1]);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { erro: 'rota não existe' });
      }

      // O que já é executado de verdade. O aplicativo só libera o envio destas.
      if (req.method === 'GET' && partes[0] === 'cordas' && partes.length === 1) {
        return json(res, 200, { versao: 1, cordas: Object.keys(CORDAS) });
      }
      if (partes[0] === 'comandos') {
        if (req.method === 'POST' && partes.length === 1) {
          const c = await lerCorpo(req);
          if (!c.processo || typeof c.processo !== 'string') return json(res, 400, { erro: 'falta "processo"' });
          const igual = c.chaveIdempotencia && pedidos.find((p) => p.chaveIdempotencia === c.chaveIdempotencia && !['desistido', 'falhou'].includes(p.estado));
          if (igual) return json(res, 200, publico(igual));
          const p = {
            id: 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            processo: c.processo, titulo: c.titulo || c.processo, risco: c.risco, pararAntesDe: c.pararAntesDe || null,
            produtor: c.produtor || null, chaveIdempotencia: c.chaveIdempotencia || null,
            comando: c, previa: Array.isArray(c.previa) ? c.previa : null,
            estado: 'na_fila', etapa: 'Na fila', log: [hora() + ' Pedido recebido'], criadoEm: new Date().toISOString(),
          };
          pedidos.push(p);
          salvar();
          setImmediate(proximo);
          return json(res, 201, publico(p));
        }
        if (req.method === 'GET' && partes.length === 1) return json(res, 200, pedidos.map(publico).reverse());
        const p = pedidos.find((x) => x.id === partes[1]);
        if (!p) return json(res, 404, { erro: 'pedido não existe' });
        if (req.method === 'GET' && partes.length === 2) return json(res, 200, publico(p));
        if (req.method === 'POST' && partes[2] === 'confirmar') {
          const espera = esperas.get(p.id);
          if (p.estado !== 'aguardando_confirmacao' || !espera) return json(res, 409, { erro: 'Este pedido não está aguardando confirmação.' });
          espera.seguir();
          return json(res, 200, publico(p));
        }
        if (req.method === 'POST' && partes[2] === 'desistir') {
          if (p.estado === 'na_fila') {
            p.estado = 'desistido';
            p.etapa = '';
            p.log.push(hora() + ' Desistido na fila: nada foi feito.');
          } else if (p.estado === 'aguardando_confirmacao' && esperas.has(p.id)) {
            p.cancelado = true;
            esperas.get(p.id).parar('Você desistiu. Nada foi enviado.');
          } else if (p.estado === 'em_execucao') {
            p.cancelado = true;
            p.log.push(hora() + ' Desistência pedida.');
          } else {
            return json(res, 409, { erro: 'Não dá mais para desistir deste pedido.' });
          }
          salvar();
          return json(res, 200, publico(p));
        }
        return json(res, 404, { erro: 'rota não existe' });
      }
      if (partes[0] === 'evidencias') return arquivo(res, join(DADOS, 'evidencias'), partes.slice(1).join('/'));
      if (partes[0] === 'arquivos') return arquivo(res, join(DADOS, 'arquivos'), partes.slice(1).join('/'));
      // Robô da PONTE: as telas são as do site do cliente (Lovable), não daqui.
      if (req.method === 'GET' && cfg.soApi) return json(res, 404, { erro: 'Este endereço é o robô do AGRO FÁCIL. Use o site.' });
      if (req.method === 'GET') return arquivo(res, cfg.app, partes.length ? partes.join('/') : 'index.html', partes[0] === 'assets');
      return json(res, 404, { erro: 'rota não existe' });
    } catch (e) {
      return json(res, 400, { erro: e.message });
    }
  });

  return {
    servidor,
    iniciar: () => setImmediate(proximo),
    pedidos: () => pedidos,
    /** Para encerrar com calma (SIGTERM do Render): grava e fecha. */
    async encerrar() {
      for (const [, e] of esperas) e.parar('O servidor foi reiniciado antes da sua confirmação. Nada foi enviado.');
      salvar();
      await new Promise((r) => servidor.close(() => r()));
    },
  };
}
