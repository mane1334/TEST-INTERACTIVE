# Kutsakai Restaurante

Gestão de restaurante e cardápio digital em feed (foto e vídeo por prato), com pedidos em tempo real, tablet em modo kiosk e painel. Refeito a partir do Kutsakai-Res com uma interface única.

## Estrutura

```
backend/          API reaproveitada do Kutsakai-Res (endurecida, ver docs/ANALISE.md)
apps/web          cardápio do cliente (feed)         [feito, ver apps/web/README.md]
apps/tablet       cliente em modo kiosk (Capacitor)  [por fazer]
apps/admin        painel do restaurante e superadmin [por fazer]
packages/design   tokens e componentes partilhados   [feito]
docs/             análise e API original
```

## Direção visual

Escura, orientada a foto e vídeo, com cor de destaque por restaurante. Ecrãs aprovados nas maquetes: feed do prato, bandeja, acompanhamento do pedido, chamar funcionário e avaliação, tablet (ecrã de proteção e grelha), painel (pedidos, métricas, pratos).

## Ordem de trabalho

1. Endurecer o backend (ver lista em docs/ANALISE.md).
2. `packages/design` com os tokens.
3. Apps web, tablet e painel, uma de cada vez.
4. CI, Docker e guia de implementação.
