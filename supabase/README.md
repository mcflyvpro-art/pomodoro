# Serveur d'alertes (Supabase, projet samuelfr-site)

Envoie une notification push à la fin de chaque phase, même app fermée ou écran verrouillé.

- `public.pomodoro_push_jobs` : alertes programmées (une ligne par fin de phase, par appareil).
- `public.pomodoro_config` : clés de notification (générées au premier appel) et secret du passage planifié. RLS activé, aucune politique : seul le rôle service y accède.
- `public.pomodoro_claim_due()` : réserve les alertes échues sans double envoi.
- Tâche pg_cron `pomodoro-push-tick` toutes les 5 s : appelle la fonction uniquement s'il y a une alerte échue.
- Fonction `pomodoro-push` (code ci-contre) : `GET` clé publique, `POST` schedule / cancel / tick.
