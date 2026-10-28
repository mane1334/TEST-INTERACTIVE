# @kutsakai/web

Cardápio do cliente em feed: um prato por ecrã, favoritos, bandeja, pedido com acompanhamento em tempo real, cancelamento na janela permitida, chamar funcionário e avaliação.

## Correr

```bash
npm install                 # na raiz do repositório
npm run dev:backend         # API em http://localhost:3000
npm run dev:web             # http://localhost:5173/?r=<ID_DO_RESTAURANTE>&mesa=<N>
```

- `?r=` identifica o restaurante (obrigatório; ou `VITE_RESTAURANT_ID` no build). Vai no cabeçalho `x-restaurant-id`.
- `?mesa=` é a mesa (vem no QR/NFC). Sem ela, o cliente escreve a mesa ao enviar.
- Cor de destaque: definição `accent` do restaurante (`brasa`, `floresta`, `oceano`, `ouro`).
- Estados do pedido da API: `pending` (Recebido), `preparing` (Em preparo), `completed` (Pronto), `cancelled`.
- Em produção o proxy deve encaminhar `/api`, `/uploads` e `/ws` (WebSocket) para o backend.

## Testes

`npm test` (funções puras). O fluxo completo foi verificado no navegador contra o backend real: feed, pedido, tempo real, avaliação, cancelamento, chamar funcionário e erro sem restaurante.

## Como funciona o vídeo e o código do pedido

- Vídeo: cada prato pode ter `video_url` (MP4 ou WebM até 25 MB, enviado com `POST /api/uploads/video`). Toca sem som quando 60% do prato está no ecrã e pára ao sair; em poupança de dados ou com "reduzir movimento" mostra o botão "Ver vídeo".
- Código do pedido: `POST /api/orders` devolve `access_code` uma única vez. O cliente guarda-o e envia-o em `x-order-code` para ver e cancelar o pedido. Sem o código, a API responde 404 (não revela que o pedido existe).
- Clientes sem login recebem pelo WebSocket só `id`, estado e tempo do pedido; o pessoal autenticado recebe o pedido completo.

## Ainda não tem

- Recuperar o acesso ao pedido se o cliente limpar o armazenamento do navegador (o pessoal vê sempre tudo).
- Limpeza de vídeos antigos quando se substitui o vídeo de um prato.
