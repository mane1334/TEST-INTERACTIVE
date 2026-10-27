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
