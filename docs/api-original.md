# Funcionalidades e endpoints

Base: `http://<host>:3000/api`. Os dados são filtrados por `restaurant_id`/`x-restaurant-id`.

## Autenticação e onboarding

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| POST | `/auth/login` | Público | Login e emissão de JWT |
| POST | `/auth/setup` | Público, uma vez | Cria o primeiro superadmin |
| POST | `/auth/register-restaurant` | Público | Regista restaurante e administrador |

## Menu, categorias e imagens

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| GET | `/menu` | Cliente | Lista pratos disponíveis |
| GET | `/categories` | Cliente/admin | Lista categorias |
| POST/PUT/DELETE | `/categories`, `/categories/:id` | JWT | CRUD de categorias |
| GET | `/dishes` | Admin | Lista todos os pratos |
| POST/PUT/DELETE | `/dishes`, `/dishes/:id` | JWT | CRUD de pratos e disponibilidade |
| POST | `/uploads` | JWT | Recebe imagem, redimensiona até 1280px e converte para WebP |
| GET | `/uploads/<ficheiro>` | Público | Entrega imagens processadas |

Os pratos suportam descrição, preço, categoria, imagens, tempo de preparação, calorias e indicadores de picante, vegetariano e sem glúten.

## Pedidos

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| POST | `/orders` | Cliente | Cria pedido com mesa e itens |
| GET | `/orders` | JWT | Lista pedidos com filtros/paginação |
| GET | `/orders/:id` | Cliente | Consulta um pedido |
| PUT | `/orders/:id/status` | JWT | Atualiza estado |
| PUT | `/orders/:id/prep-time` | JWT | Atualiza tempo de preparação |
| POST | `/orders/:id/cancel` | Cliente ou regra autorizada | Cancela pedido dentro das regras |
| GET | `/orders/export` | JWT | Exporta histórico em CSV |

As alterações de estado são transmitidas por WebSocket. A API valida os pratos e preços no servidor antes de criar o pedido.

## Atendimento e avaliações

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| POST | `/call-waiter` | Cliente autenticado por contexto | Chama funcionário para uma mesa |
| GET | `/waiter-calls` | JWT | Lista chamadas |
| PUT | `/waiter-calls/:id/resolve` | JWT | Resolve chamada |
| POST | `/ratings` | Cliente | Envia avaliação de pedido/prato |
| GET | `/ratings` | Cliente/admin | Lista avaliações |
| GET | `/ratings/summary` | Cliente/admin | Resumo e distribuição de ratings |

## Anúncios

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| GET | `/ads` | Cliente/admin | Lista anúncios do restaurante |
| POST | `/ads` | JWT | Cria anúncio |
| PUT | `/ads/:id` | JWT | Atualiza anúncio |
| DELETE | `/ads/:id` | JWT | Remove anúncio |

Os anúncios suportam título, conteúdo, imagem, datas de início/fim e estado ativo. O cliente usa-os no carrossel e no ecrã de proteção.

## Definições e analytics

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| GET | `/settings` | Cliente/admin | Lê configurações do restaurante |
| PUT | `/settings` | JWT | Atualiza configurações |
| GET | `/analytics` | JWT | Consulta métricas operacionais |
| GET | `/api/health` | Público | Health check da API |
| GET | `/backend/heartbeat` | Público | Heartbeat e histórico do serviço |

As definições incluem horários, moeda, tempo padrão de preparação, janela de cancelamento, idioma, tema, chat IA, avaliações, anúncios e bloqueio de ecrã.

## IA e memória operacional

| Método | Endpoint | Acesso | Função |
|---|---|---|---|
| POST | `/chat` | `x-api-key` quando configurada | Chat de texto com resposta e áudio opcional |
| POST | `/chat/voice` | `x-api-key` quando configurada | Transcreve áudio, responde e gera áudio |
| POST | `/chat/stream` | Público por implementação atual | Chat em streaming SSE |
| GET | `/ai/greeting` | Público | Saudação contextual do restaurante |
| GET/POST | `/ai/memory` | `x-api-key` quando configurada | Consulta/regista memória operacional |
| GET | `/ai/insights` | JWT | Gera insights para o painel |

## Superadmin e base de dados

Todas estas rotas exigem JWT de superadmin:

- `GET /superadmin/restaurants`
- `GET /superadmin/restaurants/:id`
- `PATCH /superadmin/restaurants/:id/status`
- `GET /superadmin/overview`
- `GET /superadmin/export`
- `GET /database/status`
- `POST /database/test`
- `GET /database/export`
- `POST /database/setup`

## Módulos auxiliares

O repositório também contém `ads-module` como serviço independente, normalmente na porta `3003`, com `GET /health` e CRUD próprio em `/api/ads`. A API principal já expõe anúncios em `/api/ads`; ao alterar o serviço independente, confirmar qual integração está ativa no ambiente.

## Observações de implementação

- Existem endpoints marcados no código como `legacy-disabled`; não devem ser usados por novos clientes.
- O painel contém uma função `importDatabase`, mas o backend atual não expõe uma rota ativa `/api/database/import`; esta função precisa ser tratada como pendência ou removida do cliente.
- Os endpoints de escrita são protegidos por JWT e os endpoints de cliente dependem do contexto do restaurante e da mesa.

