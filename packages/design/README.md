# @kutsakai/design

Tokens e componentes CSS partilhados por web, tablet e painel.

```css
@import "@kutsakai/design/index.css";
```

A cor de destaque do restaurante escolhe-se com `<html data-accent="floresta">` (brasa, floresta, oceano, ouro) ou sobrepondo `--kt-accent`.
Fontes (adicionar no HTML): Bricolage Grotesque 500/700 e DM Sans 400/500/700, do Google Fonts.
Contraste verificado: texto principal e `--kt-muted` sobre `--kt-bg` ≥ 4.5:1; `--kt-on-accent` sobre qualquer cor de destaque ≥ 4.5:1.
