# BibleStudy deployment (OpenTofu)

Manages the production BibleStudy stack on the VPS through `modules/app` of SubZeroDev.Infra: the Portainer
Git stack (stack 16, project `biblestudy`), the Cloudflare tunnel route and DNS record for
`biblestudy.subzerodev.com`, and the GitHub `production` environment (`INFRA_DISPATCH_TOKEN`).

Run everything through `./deploy/tofu.ps1`; it loads credentials from your User-scope environment and the
stack's values from a private var-file outside the repository.

## First adoption

1. Merge the change that adds `compose.tunnel.yaml` first. The stack is recreated (its volumes are kept) and
   the overlay must already be on `main` or the create fails.
2. In the SubZeroDev.Infra repository, write the var-file from the running stack (prints names only):

   ```powershell
   ./scripts/export-stack-env.ps1 -StackId 16 `
     -SecretNames DB_PASSWORD,APP_SECRET,SMTP_URL `
     -Skip BIBLESTUDY_IMAGE `
     -Out "$HOME\.subzerodev\biblestudy.tfvars.json"
   ```

   `DB_PASSWORD` must stay exactly what it is: it lives inside the `db` volume.
3. `./deploy/tofu.ps1 plan -var initial_image=ghcr.io/the-running-dev/subzerodev.biblestudy@sha256:<digest>`
   using the digest of the first image built from `main`; then `apply`.
4. Check `https://biblestudy.subzerodev.com/__health`, and that a second `plan` shows no changes.
5. Delete the old Nginx Proxy Manager host.

## Deploys

A push to `main` builds the image, then the `deploy` job in `deploy.yml` starts the Infra deploy workflow
with its digest. Infra validates it, redeploys the stack and waits until `/__health` reports that commit.
