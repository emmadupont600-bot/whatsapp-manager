#!/usr/bin/env node
/** Patch whatsapp-web.js getChat: LID sync for unknown contacts (PR #5816). */
const fs = require('fs');
const path = require('path');

const utilsPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
if (!fs.existsSync(utilsPath)) {
  console.log('[patch-wwebjs-lid] whatsapp-web.js not installed, skip');
  process.exit(0);
}

let src = fs.readFileSync(utilsPath, 'utf8');
if (src.includes('constructUsyncDeltaQuery')) {
  console.log('[patch-wwebjs-lid] already patched');
  process.exit(0);
}

const oldBlock = `        } else {
            chat =
                window.require('WAWebCollections').Chat.get(chatWid) ||
                (
                    await window
                        .require('WAWebFindChatAction')
                        .findOrCreateLatestChat(chatWid)
                )?.chat;
        }`;

const newBlock = `        } else {
            chat = window.require('WAWebCollections').Chat.get(chatWid);
            if (!chat) {
                chat = (
                    await window
                        .require('WAWebFindChatAction')
                        .findOrCreateLatestChat(chatWid)
                        .catch(() => null)
                )?.chat;
            }
            if (!chat) {
                try {
                    const query = window.require('WAWebContactSyncUtils').constructUsyncDeltaQuery([{
                        type: 'add',
                        phoneNumber: chatWid.user
                    }]);
                    const result = await query.execute();
                    if (result?.list?.[0]?.lid) {
                        const chatLid = window.require('WAWebWidFactory').createWid(result.list[0].lid);
                        chat = (
                            await window
                                .require('WAWebFindChatAction')
                                .findOrCreateLatestChat(chatLid)
                                .catch(() => null)
                        )?.chat;
                    }
                } catch (e) { /* LID sync unavailable */ }
            }
        }`;

if (!src.includes(oldBlock)) {
  console.error('[patch-wwebjs-lid] block not found — whatsapp-web.js version mismatch');
  process.exit(1);
}

fs.writeFileSync(utilsPath, src.replace(oldBlock, newBlock, 1));
console.log('[patch-wwebjs-lid] patched', utilsPath);
