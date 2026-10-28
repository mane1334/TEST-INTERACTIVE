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

## Ainda não tem

- Vídeo por prato: o backend só guarda imagens (`image_url`, `image_urls`). Falta o campo `video_url`, o upload de vídeo e o `<video>` no feed.
- Nota para a cozinha no pedido: a API ainda não a guarda.
- Código de acesso por pedido (hoje o pedido é consultado pelo número sequencial).
