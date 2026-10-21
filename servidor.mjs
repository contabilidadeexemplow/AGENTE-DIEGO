// Liga o servidor do AGRO FÁCIL (aplicativo + API + execução no SIARE).
//   No PC:      node orquestrador/servidor.mjs   → http://localhost:5181
//   No Render:  o Dockerfile roda o mesmo arquivo (veja DEPLOY-RENDER.md).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { criarServidor } from './app.mjs';
import { CORDAS } from './cordas.mjs';
import { lerConfig } from './config.mjs';

let cfg;
try {
  cfg = lerConfig();
} catch (e) {
  console.error('Configuração inválida: ' + e.message);
  process.exit(1);
}
// Como robô de um cliente da PONTE não há aplicativo para servir (as telas são
// as do site): o aviso só confundiria quem lê o log do Render.
if (!cfg.soApi && !existsSync(join(cfg.app, 'index.html'))) {
  console.warn('Aviso: o aplicativo não foi compilado (manete-web/dist). Rode "npm run build" dentro de manete-web.');
}

/** O modo, do jeito que importa para quem lê o log. */
function modo() {
  if (cfg.segredoDoSite) return 'robô de um cliente da PONTE (sem janela; só o site do cliente, com o segredo dele)';
  if (cfg.naNuvem) return 'internet (sem janela, com código de acesso)';
  return 'PC' + (cfg.codigoAcesso ? ' · código de acesso ligado' : '');
}

const app = criarServidor(cfg);
app.servidor.listen(cfg.porta, cfg.host, () => {
  console.log(`AGRO FÁCIL no ar: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.porta}`);
  console.log(`Modo: ${modo()}`);
  console.log(`Funções executadas: ${Object.keys(CORDAS).join(', ')}`);
  console.log(cfg.ponteUrl
    ? `Senhas do SIARE: no cofre da PONTE (${cfg.ponteUrl}), pedidas a cada login`
    : `Senhas guardadas: ${cfg.credenciais.size} produtor(es)`);
  if (cfg.segredoDoPing) console.log('"Acordar agora" da PONTE: ligado');
  app.iniciar();
});

// O Render manda SIGTERM antes de trocar a versão: grava tudo e sai.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, async () => {
    console.log(`Recebi ${sinal}: encerrando com calma.`);
    const prazo = setTimeout(() => process.exit(0), 8000);
    await app.encerrar().catch(() => undefined);
    clearTimeout(prazo);
    process.exit(0);
  });
}
