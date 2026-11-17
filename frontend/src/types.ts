// Plain data types shared by api.ts and accounts.ts.
// No browser or library code here, so Node's test runner can load files that use them.

export type BasicUser = {
  id: string
  email: string
  username: string
  email_verified?: boolean
}

export type Profile = BasicUser & {
  display_name?: string | null
  avatar_url?: string | null
  theme_color?: string | null
  custom_theme_image_url?: string | null
  timezone?: string | null
  theme_mode?: string | null
  phone_number?: string | null
  birthday?: string | null
  subscription_status: string
  email_verified: boolean
  is_admin?: boolean
}
