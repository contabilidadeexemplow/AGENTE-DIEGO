// Configuração do servidor do AGRO FÁCIL, lida do ambiente.
//
// No PC (padrão): escuta só em 127.0.0.1:5181, abre o navegador com janela e
// não pede código de acesso.
// Na internet (Render): escuta em 0.0.0.0:$PORT, navegador sem janela, e
// RECUSA subir sem CODIGO_ACESSO: sem ele, qualquer pessoa com o endereço
// mandaria pedidos ao SIARE em nome do produtor.
//
// Como robô de um cliente da PONTE (kit AGRO FÁCIL): quem fala com este
// servidor é só o servidor do site do cliente, com SEGREDO_DO_SITE no
// cabeçalho; a senha do SIARE vem do cofre da PONTE (PONTE_URL e
// PONTE_CHAVE_ROBO); e ele não serve telas (o site é o do Lovable).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const digitos = (s) => String(s ?? '').replace(/\D/g, '');

function numero(env, nome, padrao) {
  const v = env[nome];
  if (v == null || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${nome} precisa ser um número (veio "${v}").`);
  return n;
}

/**
 * Senhas do SIARE, por IE. Vêm de um segredo do Render: o arquivo
 * SIARE_CREDENCIAIS_ARQUIVO (Secret File) ou a variável SIARE_CREDENCIAIS.
 * Formato: { "<IE com 13 dígitos>": { "cpf": "<11 dígitos>", "senha": "..." } }.
 * Nunca vão para log, pedido, evidência ou resposta da API.
 */
export function lerCredenciais(env = process.env) {
  let texto = env.SIARE_CREDENCIAIS || '';
  const arquivo = env.SIARE_CREDENCIAIS_ARQUIVO || (existsSync('/etc/secrets/siare.json') ? '/etc/secrets/siare.json' : '');
  if (arquivo) {
    if (!existsSync(arquivo)) throw new Error(`SIARE_CREDENCIAIS_ARQUIVO aponta para um arquivo que não existe: ${arquivo}`);
    texto = readFileSync(arquivo, 'utf8');
  }
  if (!texto.trim()) return new Map();
  let bruto;
  try {
    bruto = JSON.parse(texto);
  } catch {
    // Não mostra o conteúdo: pode ter senha.
    throw new Error('SIARE_CREDENCIAIS não é um JSON válido.');
  }
  const mapa = new Map();
  for (const [ie, c] of Object.entries(bruto || {})) {
    const chave = digitos(ie);
    if (chave.length !== 13) throw new Error(`SIARE_CREDENCIAIS: a IE "${ie.slice(0, 4)}…" não tem 13 dígitos.`);
    if (!c || typeof c.senha !== 'string' || !c.senha) throw new Error(`SIARE_CREDENCIAIS: falta a senha da IE ${chave.slice(0, 4)}…`);
    if (digitos(c.cpf).length !== 11) throw new Error(`SIARE_CREDENCIAIS: o CPF da IE ${chave.slice(0, 4)}… não tem 11 dígitos.`);
    mapa.set(chave, Object.freeze({ cpf: digitos(c.cpf), senha: c.senha, dominio: c.dominio || 'Produtor Rural' }));
  }
  return mapa;
}

export function lerConfig(env = process.env) {
  const naNuvem = !!(env.RENDER || env.NA_NUVEM === '1');
  const cfg = {
    naNuvem,
    porta: numero(env, 'PORT', numero(env, 'PORTA', 5181)),
    host: env.HOST || (naNuvem ? '0.0.0.0' : '127.0.0.1'),
    // Sem tela na nuvem; no PC, com janela (o login assistido precisa dela).
    semJanela: env.HEADLESS ? env.HEADLESS !== 'false' : naNuvem,
    navegador: env.CHROME_PATH || env.PUPPETEER_EXECUTABLE_PATH || '',
    codigoAcesso: env.CODIGO_ACESSO || '',
    segredoSessao: env.SEGREDO_SESSAO || '',
    // Chave para cifrar as senhas do SIARE. No PC, se vazia, o servidor gera e
    // guarda uma chave local (dados/.chave-credenciais).
    segredoCredenciais: env.SEGREDO_CREDENCIAIS || env.SEGREDO_SESSAO || '',
    origens: (env.ORIGENS || '').split(',').map((s) => s.trim()).filter(Boolean),
    dados: resolve(env.DIR_DADOS || resolve(AQUI, 'dados')),
    app: resolve(env.DIR_APP || resolve(AQUI, '..', 'manete-web', 'dist')),
    // Três recusas seguidas bloqueiam a conta no SIARE: entre um login e outro, uma pausa.
    pausaEntreLoginsMs: numero(env, 'PAUSA_ENTRE_LOGINS_MS', naNuvem ? 20000 : 3000),
    tetoConfirmacaoMs: numero(env, 'TETO_CONFIRMACAO_MS', 15 * 60000),
    tetoLoginAssistidoMs: numero(env, 'TETO_LOGIN_MS', 5 * 60000),
    credenciais: lerCredenciais(env),
    // Robô de um cliente da PONTE.
    ponteUrl: String(env.PONTE_URL || '').trim().replace(/\/+$/, ''),
    ponteChaveRobo: env.PONTE_CHAVE_ROBO || '',
    segredoDoSite: env.SEGREDO_DO_SITE || '',
    // O "Acordar agora" do painel da PONTE: GET /acordar/<PING_SEGREDO>.
    segredoDoPing: env.PING_SEGREDO || '',
    soApi: env.SO_API === '1' || !!env.SEGREDO_DO_SITE,
  };
  if (naNuvem && !cfg.codigoAcesso && !cfg.segredoDoSite) {
    throw new Error('Na internet o servidor precisa de CODIGO_ACESSO (o código que a pessoa digita para entrar) ou, como robô da PONTE, de SEGREDO_DO_SITE. Defina no painel do Render.');
  }
  // Segredo curto se adivinha; e é ele que abre a API de quem manda no SIARE.
  if (cfg.segredoDoSite && cfg.segredoDoSite.length < 32) throw new Error('SEGREDO_DO_SITE precisa ter pelo menos 32 caracteres.');
  // O do ping só acorda a máquina e não abre nada; curto, porém, qualquer um a
  // acordaria por chute, e o plano grátis do Render conta as horas acordado.
  if (cfg.segredoDoPing && cfg.segredoDoPing.length < 16) throw new Error('PING_SEGREDO precisa ter pelo menos 16 caracteres.');
  if (!!cfg.ponteUrl !== !!cfg.ponteChaveRobo) {
    throw new Error('Para usar o cofre da PONTE defina as DUAS: PONTE_URL e PONTE_CHAVE_ROBO.');
  }
  if (cfg.codigoAcesso && cfg.codigoAcesso.length < 8) throw new Error('CODIGO_ACESSO precisa ter pelo menos 8 caracteres.');
  return cfg;
}
