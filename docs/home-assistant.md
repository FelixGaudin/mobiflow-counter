# Intégrer Mobiflow counter à Home Assistant

Home Assistant interroge l'app toutes les heures via l'intégration
[RESTful](https://www.home-assistant.io/integrations/rest/) et crée une entité par chiffre.
Rien à installer côté Home Assistant.

## 1. Vérifier que Home Assistant joint l'app

L'app expose ses chiffres clés sur `/api/summary` :

```bash
curl http://<machine-docker>:8742/api/summary
```

```json
{
  "total": 412.5,
  "kwh": 1280.4,
  "year_total": 298.1,
  "monthly_average": 51.56,
  "best_month": "2030-07",
  "best_month_total": 96.2,
  "current_rate": 0.3222,
  "last_note_number": "SB-DN-A00000000-8",
  "last_note_date": "2030-09-01",
  "last_note_total": 44.75,
  "note_count": 8,
  "session_count": 96
}
```

| Champ              | Contenu                                                     |
| ------------------ | ----------------------------------------------------------- |
| `total`            | Total remboursé depuis la première fiche (€)                |
| `kwh`              | Énergie remboursée depuis la première fiche (kWh)           |
| `year_total`       | Remboursé pour les sessions de l'année civile en cours (€)  |
| `monthly_average`  | Moyenne par mois avec des sessions (€)                      |
| `best_month`       | Meilleur mois, au format `AAAA-MM`                          |
| `best_month_total` | Montant du meilleur mois (€)                                |
| `current_rate`     | Tarif de la session la plus récente (€/kWh)                 |
| `last_note_number` | Numéro de la dernière fiche déposée                         |
| `last_note_date`   | Date de la dernière fiche                                   |
| `last_note_total`  | Total de la dernière fiche (€)                              |
| `note_count`       | Nombre de fiches                                            |
| `session_count`    | Nombre de sessions                                          |

Remplace `<machine-docker>` par l'IP ou le nom de la machine qui fait tourner le conteneur.
Si Home Assistant tourne lui-même dans Docker ou sur une autre machine, `localhost` ne
marchera pas : utilise l'IP de la machine hôte sur le réseau local.

L'app n'a pas d'authentification : garde-la sur ton réseau local.

## 2. Ajouter les capteurs

Dans `configuration.yaml` (ou un fichier inclus), remplace l'URL puis redémarre Home Assistant :

```yaml
rest:
  - resource: http://192.168.1.10:8742/api/summary
    scan_interval: 3600
    sensor:
      - name: Mobiflow total
        unique_id: mobiflow_total
        value_template: "{{ value_json.total }}"
        unit_of_measurement: EUR
        device_class: monetary
        state_class: total
      - name: Mobiflow cette année
        unique_id: mobiflow_year_total
        value_template: "{{ value_json.year_total }}"
        unit_of_measurement: EUR
        device_class: monetary
        state_class: total
      - name: Mobiflow moyenne mensuelle
        unique_id: mobiflow_monthly_average
        value_template: "{{ value_json.monthly_average }}"
        unit_of_measurement: EUR
        device_class: monetary
      - name: Mobiflow meilleur mois
        unique_id: mobiflow_best_month_total
        value_template: "{{ value_json.best_month_total }}"
        availability: "{{ value_json.best_month is not none }}"
        unit_of_measurement: EUR
        device_class: monetary
        json_attributes:
          - best_month
      - name: Mobiflow tarif
        unique_id: mobiflow_rate
        value_template: "{{ value_json.current_rate }}"
        availability: "{{ value_json.current_rate is not none }}"
        unit_of_measurement: EUR/kWh
      - name: Mobiflow énergie remboursée
        unique_id: mobiflow_kwh
        value_template: "{{ value_json.kwh }}"
        unit_of_measurement: kWh
        device_class: energy
        state_class: total
      - name: Mobiflow dernière fiche
        unique_id: mobiflow_last_note_total
        value_template: "{{ value_json.last_note_total }}"
        availability: "{{ value_json.last_note_number is not none }}"
        unit_of_measurement: EUR
        device_class: monetary
        json_attributes:
          - last_note_number
          - last_note_date
```

Tu obtiens ces entités (à vérifier dans *Paramètres › Appareils et services › Entités*,
Home Assistant peut les nommer un peu autrement) :

| Entité                                | Valeur                                         |
| ------------------------------------- | ---------------------------------------------- |
| `sensor.mobiflow_total`               | Total remboursé                                |
| `sensor.mobiflow_cette_annee`         | Remboursé cette année                          |
| `sensor.mobiflow_moyenne_mensuelle`   | Moyenne par mois                               |
| `sensor.mobiflow_meilleur_mois`       | Montant du meilleur mois, mois en attribut     |
| `sensor.mobiflow_tarif`               | Tarif actuel                                   |
| `sensor.mobiflow_energie_remboursee`  | kWh remboursés                                 |
| `sensor.mobiflow_derniere_fiche`      | Total de la dernière fiche, numéro et date en attributs |

Après avoir déposé une fiche dans l'app, Home Assistant la voit au plus tard une heure
après. Pour forcer la mise à jour : *Outils de développement › Actions*,
`homeassistant.update_entity` sur `sensor.mobiflow_total`.

## 3. Exemples

### Carte de tableau de bord

```yaml
type: entities
title: Mobiflow
entities:
  - entity: sensor.mobiflow_total
    name: Total remboursé
  - entity: sensor.mobiflow_cette_annee
    name: Cette année
  - entity: sensor.mobiflow_meilleur_mois
    name: Meilleur mois
  - entity: sensor.mobiflow_moyenne_mensuelle
    name: Par mois en moyenne
  - entity: sensor.mobiflow_tarif
    name: Tarif actuel
```

### Notification à chaque nouvelle fiche

Remplace `notify.mobile_app_mon_telephone` par ton service de notification.

```yaml
alias: Mobiflow - nouvelle fiche
triggers:
  - trigger: state
    entity_id: sensor.mobiflow_derniere_fiche
    attribute: last_note_number
conditions:
  - condition: template
    value_template: "{{ trigger.from_state.attributes.last_note_number is defined }}"
actions:
  - action: notify.mobile_app_mon_telephone
    data:
      title: Nouvelle fiche Mobiflow
      message: >-
        {{ states('sensor.mobiflow_derniere_fiche') }} € remboursés
        (total {{ states('sensor.mobiflow_total') }} €).
```
