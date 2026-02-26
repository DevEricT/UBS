# UBS Portfolio Analyzer

Analyseur multi-format pour exports UBS — fork du Saxo Portfolio Analyzer.

## Formats supportés

| Format | Description | Status |
|--------|-------------|--------|
| `KEY4_EXCEL` | UBS Key4 / E-banking (Transactions + Positions) | ✅ Supporté |
| `SIMPLE_CSV` | CSV mono-feuille | ✅ Supporté |
| `ADVISOR_EXCEL` | Export conseiller UBS (Portfolio/Cash/Movements) | 🔜 À implémenter |

## Architecture

```
processUBS()
  └── detectUBSFormat()      → détecte le template parmi les feuilles
  └── parseKey4()            → parse Key4/CSV avec détection dynamique des colonnes
  └── parseAdvisor()         → parse format conseiller (TODO)
  └── buildEmptyResult()     → fallback format inconnu
```

## Démarrage

```bash
npm install
npm run dev
```

## Ajouter un nouveau format UBS

1. Uploader le fichier → regarder les feuilles détectées (onglet Config)
2. Ajouter une condition dans `detectUBSFormat()`
3. Créer un parser `parseXxx()` sur le modèle de `parseKey4()`
4. Mapper les colonnes via `findCol()` + `UBS_KEY4_COLS` ou un nouveau dict

## Colonnes UBS connues (à compléter avec vrai fichier)

| Concept | Candidats testés |
|---------|-----------------|
| Date | "Date", "Date de valeur", "Booking date", "Date comptable" |
| Montant | "Montant", "Amount", "CHF", "EUR" |
| Type | "Type", "Category", "Catégorie" |
| Titre | "Titre", "Security", "ISIN", "Valeur" |
| Compte | "Compte", "Account", "Konto" |
