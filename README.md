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
   - `GROQ_API_KEY` : clé [Groq](https://console.groq.com) (spin text + question IA)
   - `GROQ_MODEL` : optionnel (défaut `llama-3.3-70b-versatile`)
   - `AI_SPIN=0` : désactive les variantes IA
   - `COLD_OPENER_MESSAGE=0` : pas de « Hey » avant la question (recommandé avec opt-in)

### Campagne (Groq + opt-in)

1. Texte + lien du groupe → **Valider & préparer** (Groq transforme en question si lien présent).
2. Import CSV → **Démarrer** : **1 question** par contact (plus de double envoi texte+lien).
3. **Spin IA** : 1er contact = texte validé, suivants = variantes.
4. **Lien** envoyé uniquement après réponse positive (oui, chaud, 👍).

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
