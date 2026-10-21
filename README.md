# ROBO DO AGRO FACIL — DIEGO LEONARDO GONÇALVES DE SOUZA

Este repositorio e o robo que faz, no SIARE, as funcoes do seu AGRO FACIL:
emitir, cancelar e imprimir NFA, DAE, cadastro, acessos e consultas. Ele roda
no Render e so atende o servidor do seu site.

## COMO SUBIR

A PONTE cria o servico no Render sozinha. A mao, se precisar:

1. No Render, "New" > "Blueprint" e aponte para este repositorio.
2. O Render vai pedir quatro variaveis. Elas NAO estao neste repositorio de
   proposito — chave que entra em Git nao se apaga, so se revoga. O bloco do
   robo, no painel da PONTE, mostra as quatro prontas para copiar:

   | Variavel | Valor |
   |---|---|
   | `PONTE_URL` | `https://ponte-sefaz.vercel.app` |
   | `PONTE_CHAVE_ROBO` | a chave de escopo **robo** (comeca com `nfe_`) |
   | `SEGREDO_DO_SITE` | o que o painel da PONTE mostra no bloco do robo |
   | `PING_SEGREDO` | o do botao "Sortear", no mesmo bloco |

3. Cadastre no painel da PONTE o endereco que o Render deu e o mesmo
   PING_SEGREDO (botao "Gravar"). "Acordar agora" confere os dois.

## O QUE ESTE ROBO NAO FAZ

Nao guarda a senha do SIARE: ela vem do cofre da PONTE a cada login e morre
com o processo. Nao tem banco: o historico e os cadastros ficam no Lovable
Cloud do seu site. E nao mostra telas: o site e o app sao os do AGRO FACIL.
