# Mobiflow counter

Suivi des remboursements de recharge à domicile Mobiflow. On dépose les fiches PDF
(« Debit note ») et l'app affiche les montants, l'énergie, les habitudes de charge
et contrôle chaque fiche.

## Lancer

```bash
docker compose up -d --build
```

Puis ouvrir http://localhost:8742 et glisser les PDF n'importe où sur la page.
Pour un autre port : `MOBIFLOW_PORT=9000 docker compose up -d`.

Les données (base SQLite + PDF originaux) sont dans `./data`, monté sur `/data` dans
le conteneur. Sauvegarder ce dossier suffit.

## Ce que fait l'app

- Lit chaque fiche : numéro, dates, sessions (début, fin, durée, tarif, kWh, montant), total.
  Redéposer une fiche la remplace.
- Contrôle chaque session : montant = kWh × tarif (à 1 centime près). Si une ligne est
  fausse mais que le total de la fiche l'inclut, elle est marquée « corrigée par le total » ;
  sinon le manque est indiqué dans la colonne « Contrôle ».
- Graphes : calendrier des jours de charge, remboursement par mois, cumul remboursé.
- Export CSV de toutes les sessions.

## Développement

```bash
uv venv -p 3.13 .venv && uv pip install -p .venv -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --reload   # données dans ./data
.venv/bin/python -m pytest tests
```
