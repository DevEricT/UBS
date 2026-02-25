# 📊 Saxo Analyzer

Application React pour analyser les exports de portefeuille Saxo Bank.

## Fichier attendu

`AggregatedAmounts_XXXXXXXX_YYYY-MM-DD_YYYY-MM-DD.xlsx`

## Fonctionnalités

- 📋 **Vue d'ensemble** — KPIs : valeur totale, capital investi, résultat net, TWR officiel Saxo
- 📈 **Performance** — Courbes TWR et valeur du portefeuille, Top/Flop 10 positions
- 💼 **Positions** — Tableau complet avec P&L Net (source onglet B/P Saxo)
- 📅 **Trends** — Graphiques mensuels : dépôts, achats/ventes, frais, dividendes
- 💰 **Frais** — Détail commissions, taxes FFT, exchange fees
- 🔽 **Export CSV** — KPIs + toutes les positions
- 📄 **Export PDF** — Rapport professionnel imprimable

## Filtres

Sélecteur de compte pour analyser séparément :
- Compte Principal EUR
- PEA
- PEA-PME
- Autres comptes

## Installation

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Tech

- React 18 + Vite
- Recharts (graphiques)
- SheetJS/xlsx (lecture Excel)
- Tailwind CSS
