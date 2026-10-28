# Análise do Kutsakai-Res: o que corrigir no backend

Por ordem de gravidade:

1. WebSocket sem autenticação nem isolamento: `wss.broadcast` envia a todos os clientes e transmite o conteúdo dos logs (stdout/stderr) a quem se ligar.
2. Restaurante identificado pelo cabeçalho `x-restaurant-id`, com fallback para o restaurante 1.
3. Quantidades dos itens do pedido sem validação suficiente.
4. Desvio de autenticação em `NODE_ENV=test`.
5. `/chat/stream` público (gasta a quota da IA).
6. Chave Gemini embutida no APK Kotlin (deve passar pelo backend).
7. SQL por interpolação no analytics.
8. `index.js` monolítico, poucos testes, sem CI.
9. Logs e `debug.keystore` no git (não copiados para este repositório).
10. `importDatabase` no painel sem rota no backend; rotas `legacy-disabled`.

## Corrigido neste repositório

- 1, 2, 3, 4, 5: WebSocket autenticado e isolado, restaurante sem fallback, quantidades validadas, desvio de testes explícito, `/chat/stream` limitado (testes em `backend/tests/security.test.js`).
- Encontrado ao testar de ponta a ponta com SQLite:
  - Primeiro arranque com base nova caía com `no such table: restaurants` (instruções SQLite fora de ordem). Agora o modo é serializado.
  - `UPDATE/INSERT ... RETURNING` devolvia só `{ id: lastID }`; o tempo real enviava estados vazios. Agora devolve as linhas.
  - O token do registo de restaurante saía sem `restaurant_id` e `role`, e o novo dono caía no restaurante 1. Agora leva ambos.
  - Datas do SQLite (UTC sem fuso) eram lidas como hora local: com o servidor em Maputo (UTC+2) a janela de cancelamento aparecia sempre expirada e as estatísticas ficavam 2 h desfasadas.
  - `GET /api/settings` não devolvia o nome de restaurantes novos.
- Pedidos: código de acesso aleatório (já não se adivinha o pedido pelo número), nota para a cozinha, clientes sem login só recebem id/estado no tempo real, cancelamento do cliente só enquanto o pedido está novo.
- Vídeo por prato: `video_url`, upload validado pelos bytes (MP4/WebM), `video_url` só aceita ficheiro nosso ou https.
- Por fazer: 6 (Gemini no APK, a app Kotlin deixa de existir), 7 a 10.

## Encontrado e ainda por corrigir (modo PostgreSQL)

- Várias consultas de analytics em PostgreSQL não filtram por `restaurant_id` (`FROM orders WHERE 1=1 ...`): um restaurante veria números de outros. Em SQLite filtram.
- `database/schema.sql` está desatualizado face ao código (falta `restaurant_id`, `image_urls`, etc.); só tem as colunas novas acrescentadas aqui. Antes de usar PostgreSQL em produção, é preciso um esquema completo e migrações.
- Ao substituir o vídeo ou a imagem de um prato, o ficheiro antigo do vídeo não é apagado.
