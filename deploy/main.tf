# Adopts the existing BibleStudy stack (Portainer stack 16) into OpenTofu through modules/app of
# SubZeroDev.Infra: Cloudflare tunnel and DNS for biblestudy-app, the Portainer Git stack and the GitHub
# `production` environment. Run through deploy/tofu.ps1; see deploy/README.md.
terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "5.28.1" }
    portainer  = { source = "portainer/portainer", version = "2.2.0" }
    github     = { source = "integrations/github", version = "6.13.0" }
    random     = { source = "hashicorp/random", version = "3.9.1" }
    http       = { source = "hashicorp/http", version = "3.6.3" }
  }

  # Bucket, key and endpoint come from backend.hcl (Git-ignored); R2 keys from AWS_ACCESS_KEY_ID and
  # AWS_SECRET_ACCESS_KEY, which tofu.ps1 maps from the R2_* variables.
  backend "s3" {
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN

provider "github" {
  owner = "The-Running-Dev" # GITHUB_TOKEN
}

provider "portainer" {
  endpoint = var.portainer_url
  api_key  = var.portainer_api_key
  custom_headers = {
    "CF-Access-Client-Id"     = var.cf_access_client_id
    "CF-Access-Client-Secret" = var.cf_access_client_secret
  }
}

module "app" {
  source = "git::https://github.com/The-Running-Dev/SubZeroDev.Infra.git//modules/app?ref=v2.0.0"

  name          = "biblestudy" # The existing Portainer stack name; Portainer passes it as the compose project, which names the volumes
  repository    = "The-Running-Dev/SubZeroDev.BibleStudy"
  compose_files = ["compose.yaml", "compose.tunnel.yaml"]

  routes = { biblestudy = "http://biblestudy-app:3000" } # biblestudy.subzerodev.com

  image = {
    variable = "BIBLESTUDY_IMAGE"
    initial  = var.initial_image # applied once at import; deploys own the image afterwards
  }

  # Names and values come from the private var-file that tofu.ps1 loads (scripts/export-stack-env.ps1 in the
  # Infra repository writes it from the running stack): PUBLIC_URL, MAIL_FROM, OWNER_EMAIL ...
  env = var.env

  # DB_PASSWORD (must stay what the db volume holds), APP_SECRET, SMTP_URL.
  secrets = var.secrets

  health_path   = "/__health"
  portainer_url = var.portainer_url
  portainer_credentials = {
    api_key              = var.portainer_api_key
    access_client_id     = var.cf_access_client_id
    access_client_secret = var.cf_access_client_secret
  }
  dispatch_token  = var.dispatch_token # stored as INFRA_DISPATCH_TOKEN; starts the Infra deploy workflow
  git_credentials = null               # the repository is public
  registry_ids    = [1]                # the shared ghcr.io registry
}

# Adopt what already exists, so nothing is recreated. The provider forces a replacement of the stack
# (additional_files): the stack is deleted and created again, its named volumes are kept.
import {
  to = module.app.portainer_stack.this
  id = "3-16-standalone-repository" # <endpoint>-<stack>-<type>-<method>
}

import {
  to = module.app.cloudflare_dns_record.route["biblestudy"]
  id = "e958380ca90211dfa0fc68c5c2df277f/883357bd8234ee356a7d6fb51c6feb89"
}

import {
  to = module.app.github_actions_variable.deploy_enabled
  id = "SubZeroDev.BibleStudy:DEPLOY_ENABLED"
}

output "public_url" {
  value = "https://biblestudy.subzerodev.com"
}
