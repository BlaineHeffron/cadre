# GrapheneOS phone sync

Automatic sync uses ADB. On the phone, enable **Developer options > USB debugging**, connect by USB, unlock, and authorize this computer once.

Install the user timer with the actual shared-drive destination:

```bash
GRAPHENE_BACKUP_DIR="/path/to/shared-drive/GrapheneOS" \
  bash scripts/install-graphene-phone-sync.sh
```

Defaults:

- Phone shared storage: `/sdcard`
- Phone recordings: `/sdcard/Recordings`
- SoundTree recordings: `/sdcard/Android/data/app.soundtree/files/recordings`
- Dueno audio inbox: `~/.dueno-fleet/audio-inbox`
- Fallback backup directory: `~/Shared/GrapheneOS`

Override these with `GRAPHENE_PHONE_STORAGE_DIR`, `GRAPHENE_PHONE_RECORDINGS_DIR`, `GRAPHENE_PHONE_SOUNDTREE_DIR`, and `GRAPHENE_AUDIO_INBOX_DIR` during installation. Set `GRAPHENE_DEVICE_SERIAL` when multiple authorized Android devices may be attached.

The timer polls every 20 seconds, but syncs only once per cable connection. It never deletes local or phone files. Recordings copy into the inbox even when the backup disk is read-only. Force a test sync:

```bash
GRAPHENE_FORCE_SYNC=1 systemctl --user start dueno-graphene-sync.service
journalctl --user -u dueno-graphene-sync.service -n 100
```

This backs up Android shared storage when the backup directory is writable. GrapheneOS app-private data remains inaccessible to ADB by design; use each app's export/backup mechanism for private data. SoundTree recordings are imported from the app files tree when ADB can read that path.

For automatic processing, Cadre must have audio transcription and inbox ingestion enabled. The phone sync copies `.m4a`, `.mp3`, and `.wav` files into the configured audio inbox.

## Old recording archive

Install the daily archive timer, pointing it at the mounted archive drive:

```bash
FLEET_RECORDING_ARCHIVE_MOUNT=/path/to/drive bash scripts/install-recording-archive.sh
```

It moves inbox-root audio older than 30 days to `<mount>/Dueno Recordings Archive/YYYY/MM` only after a sibling transcript exists. Transcript files remain in the Dueno inbox. Override the threshold with `FLEET_RECORDING_ARCHIVE_MIN_AGE_DAYS` during installation.
