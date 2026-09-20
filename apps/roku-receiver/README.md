# Remote Workspace Receiver

Enable developer mode on the Roku, then package this directory and upload the ZIP on the Roku development installer page:

```sh
cd apps/roku-receiver
zip -r /tmp/remote-workspace-roku.zip manifest source components
```

The receiver occupies Roku's single development-channel slot. Its title must remain `Remote Workspace Receiver` so the file browser can verify it before casting.
