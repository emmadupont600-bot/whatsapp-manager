# WhatsApp Manager

Dashboard web pour gérer l'envoi de messages WhatsApp, avec import/export CSV, anti-ban, et hébergement Railway.

## Démarrage local

```bash
npm install
npm start
# Ouvrez http://localhost:3000
```

## Déploiement sur Railway

1. Connectez-vous sur [railway.app](https://railway.app)
2. **New Project** → **Deploy from GitHub repo** → sélectionnez `whatsapp-manager`
3. Railway détecte automatiquement le Dockerfile
4. Allez dans **Settings → Volumes** et ajoutez :
   - `/app/.wwebjs_auth` → session WhatsApp persistante
   - `/app/data` → sauvegarde de la queue
5. Variables d'environnement optionnelles :
   - `MIN_DELAY_S` : délai minimum (défaut: 45)
   - `MAX_DELAY_S` : délai maximum (défaut: 120)
   - `WA_WEB_VERSION` : version WhatsApp Web épinglée (évite session fantôme)
   - `AUTO_START_ON_READY=0` : désactive le démarrage auto de la queue après connexion
   - `RESET_AUTH=1` : supprime la session au redémarrage (puis retirez la variable)
6. Cliquez **Deploy** → attendez le build (~3 min)
7. Ouvrez l'URL publique Railway → scannez le QR code

### Envoi silencieux / session fantôme

Si les logs affichent « Envoyé » mais rien sur le téléphone, ou le **même ID** pour texte et lien :

1. **Pause** la queue immédiatement
2. Sur le téléphone : déconnectez **tous** les Appareils connectés WhatsApp Web
3. Dashboard → **Reset Auth** → rescannez le QR
4. **Message test** vers votre propre numéro — doit apparaître dans vos conversations
5. Bouton **Vérifier synchronisation session** → doit afficher OK
6. Si le numéro a été **restreint** par WhatsApp : attendez 24–48 h ou utilisez le **Compte 2**

Le bot détecte automatiquement les IDs dupliqués et arrête la queue pour éviter d'envoyer dans le vide.
