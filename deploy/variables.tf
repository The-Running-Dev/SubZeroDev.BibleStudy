variable "state_passphrase" {
  description = "Encrypts the state and plans stored in R2."
  type        = string
  sensitive   = true
}

variable "portainer_url" {
  type    = string
  default = "https://containers.subzerodev.com"
}

variable "portainer_api_key" {
  type      = string
  sensitive = true
}

variable "cf_access_client_id" {
  description = "Cloudflare Access service token in front of Portainer."
  type        = string
  sensitive   = true
}

variable "cf_access_client_secret" {
  type      = string
  sensitive = true
}

variable "dispatch_token" {
  description = "Token with Actions write on the Infra repository only; the deploy job uses it to start the Infra deploy workflow."
  type        = string
  sensitive   = true
}

variable "initial_image" {
  description = "Image applied when the stack is created, pinned by digest (ghcr.io/the-running-dev/subzerodev.biblestudy@sha256:...). Pass it with -var; deploys own the image afterwards."
  type        = string
}

variable "env" {
  description = "Plain stack values read from the running stack (private var-file)."
  type        = map(string)
}

variable "secrets" {
  description = "Secret stack values read from the running stack (private var-file)."
  type        = map(string)
  sensitive   = true

  validation {
    condition     = alltrue([for k in ["DB_PASSWORD", "APP_SECRET", "SMTP_URL"] : contains(keys(var.secrets), k)])
    error_message = "secrets needs DB_PASSWORD (it must match the biblestudy-db volume) APP_SECRET and SMTP_URL."
  }
}
