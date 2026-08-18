import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect, useRef } from 'react'
import type { AiChatAuthorInfo, OpenCodeSkillDefinition, OpenCodeUserCustomization } from '@gadgets/workshop-shared/api'
import { hashPassword } from './passwordHash'
import { CF_ACCESS_MODE } from './useAuth'
import { User, Pencil, Check, X, Lock, Camera, Copy, Eye, EyeSlash, Plus, Trash } from '@phosphor-icons/react'
import { useAvatar, invalidateAvatarCache } from './useAvatar'
import { compressAvatar, avatarBlobUrl } from './avatarUtils'
import UsageSettings from './components/billing/UsageSettings'
import { useDocumentTitle } from './useDocumentTitle'

// Shared, on-language control classes (match the rest of the app: Workspaces/Blueprints headers,
// the gatekeepers toolbar, the command palette). Kept here so the profile page reads as part of the
// system rather than a stack of default Kumo cards.
const PRIMARY_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
const ICON_BTN =
  'press grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default'
const INPUT =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'
const TEXTAREA =
  'w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'

const EMPTY_OPENCODE_CUSTOMIZATION: OpenCodeUserCustomization = {
  plugins: [],
  skills: [],
}

const NPM_PACKAGE_NAME_REGEX = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@\S+)?$/

function normalizeOpenCodeCustomization(pluginPackageLines: string, skills: OpenCodeSkillDefinition[]): OpenCodeUserCustomization {
  return {
    plugins: pluginPackageLines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    skills: skills
      .map((skill) => ({
        name: skill.name.trim(),
        description: skill.description.trim(),
        instructions: skill.instructions.trim(),
      }))
      .filter((skill) => skill.name || skill.description || skill.instructions),
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
      {children}
    </h2>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">{children}</p>
  )
}

// On-language password field: same input/focus treatment as the rest of the app, with an inline
// show/hide toggle (replacing Kumo's SensitiveInput, which read as dated against the new look).
function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  description,
  error,
  autoComplete,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  description?: string
  error?: string | null
  autoComplete?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative mt-1.5">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={`${INPUT} pr-10 ${error ? 'border-kumo-danger focus:border-kumo-danger' : ''}`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-kumo-inactive transition-colors hover:text-kumo-default"
        >
          {show ? <EyeSlash size={15} /> : <Eye size={15} />}
        </button>
      </div>
      {error ? (
        <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-danger">{error}</p>
      ) : description ? (
        <p className="mt-1 text-[12px] tracking-[-0.1px] text-kumo-subtle">{description}</p>
      ) : null}
    </div>
  )
}

export default function SettingsPage() {
  useDocumentTitle('Profile')

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  // Avatar state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [localAvatarPreview, setLocalAvatarPreview] = useState<string | null>(null)

  // Revoke preview blob URL on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (localAvatarPreview) URL.revokeObjectURL(localAvatarPreview)
    }
  }, [localAvatarPreview])

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  // Whether this account has a password (false for OAuth-created accounts). Null while loading.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)

  // OpenCode customization state
  const [openCodePlugins, setOpenCodePlugins] = useState('')
  const [openCodeSkills, setOpenCodeSkills] = useState<OpenCodeSkillDefinition[]>([])
  const [openCodeLoading, setOpenCodeLoading] = useState(true)
  const [openCodeSaving, setOpenCodeSaving] = useState(false)
  const [openCodeError, setOpenCodeError] = useState<string | null>(null)

  const avatarUrl = useAvatar(authenticatedApi, userInfo?.id)

  // Determine whether to show the change-password section.
  useEffect(() => {
    let cancelled = false
    authenticatedApi.hasPasswordLogin()
      .then((v: boolean) => { if (!cancelled) setHasPassword(v) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Fetch account-scoped OpenCode customization.
  useEffect(() => {
    let cancelled = false
    const fetchOpenCodeCustomization = async () => {
      setOpenCodeLoading(true)
      setOpenCodeError(null)
      try {
        const customization = await authenticatedApi.getOpenCodeCustomization()
        if (cancelled) return
        setOpenCodePlugins((customization.plugins ?? []).join('\n'))
        setOpenCodeSkills(customization.skills ?? [])
      } catch (error) {
        console.error('Failed to fetch OpenCode customization:', error)
        if (!cancelled) {
          setOpenCodeError('Failed to load OpenCode settings')
          setOpenCodePlugins(EMPTY_OPENCODE_CUSTOMIZATION.plugins.join('\n'))
          setOpenCodeSkills(EMPTY_OPENCODE_CUSTOMIZATION.skills)
          toasts.add({ title: 'Failed to load OpenCode settings', variant: 'error' })
        }
      } finally {
        if (!cancelled) setOpenCodeLoading(false)
      }
    }

    fetchOpenCodeCustomization()
    return () => { cancelled = true }
  }, [authenticatedApi, toasts])

  // Fetch user info
  useEffect(() => {
    let cancelled = false
    const fetchUserInfo = async () => {
      try {
        const info = await authenticatedApi.whoami()
        if (cancelled) return
        setUserInfo(info)
        setNameInput(info.name)
      } catch (error) {
        console.error('Failed to fetch user info:', error)
        if (!cancelled) toasts.add({ title: 'Failed to load user information', variant: 'error' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchUserInfo()
    return () => { cancelled = true }
  }, [authenticatedApi])

  const handleSaveName = async () => {
    if (!nameInput.trim()) {
      toasts.add({ title: 'Display name cannot be empty', variant: 'error' })
      return
    }

    try {
      await authenticatedApi.setOwnDisplayName(nameInput.trim())
      setUserInfo(prev => prev ? { ...prev, name: nameInput.trim() } : null)
      setIsEditingName(false)
      toasts.add({ title: 'Display name updated', variant: 'success' })
    } catch (err) {
      console.error('Failed to update display name:', err)
      toasts.add({ title: 'Failed to update display name', variant: 'error' })
    }
  }

  const handleCancelEdit = () => {
    setNameInput(userInfo?.name || '')
    setIsEditingName(false)
  }

  const handleCopyId = async () => {
    if (!userInfo?.id) return
    try {
      await navigator.clipboard.writeText(userInfo.id)
      toasts.add({ title: 'User ID copied', variant: 'success' })
    } catch {
      toasts.add({ title: 'Failed to copy', variant: 'error' })
    }
  }

  const handleAvatarUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toasts.add({ title: 'Please select an image file', variant: 'error' })
      return
    }
    setAvatarUploading(true)
    try {
      const compressed = await compressAvatar(file)
      // Show preview immediately
      if (localAvatarPreview) URL.revokeObjectURL(localAvatarPreview)
      setLocalAvatarPreview(avatarBlobUrl(compressed))
      // Upload
      await authenticatedApi.setAvatar(compressed)
      // Invalidate cache so the hook refetches
      if (userInfo?.id) invalidateAvatarCache(userInfo.id)
      toasts.add({ title: 'Avatar updated', variant: 'success' })
    } catch (err) {
      console.error('Failed to upload avatar:', err)
      setLocalAvatarPreview(null)
      toasts.add({ title: 'Failed to upload avatar', variant: 'error' })
    } finally {
      setAvatarUploading(false)
    }
  }

  const handleChangePassword = async () => {
    if (!userInfo) return
    if (!currentPassword || !newPassword || !confirmPassword) return
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setPasswordLoading(true)
    setPasswordError(null)

    try {
      const oldHash = await hashPassword(userInfo.id, currentPassword)
      const newHash = await hashPassword(userInfo.id, newPassword)
      await authenticatedApi.changePassword(oldHash, newHash)
      toasts.add({ title: 'Password changed successfully', variant: 'success' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to change password'
      setPasswordError(errorMessage)
    } finally {
      setPasswordLoading(false)
    }
  }

  const updateOpenCodeSkill = (index: number, patch: Partial<OpenCodeSkillDefinition>) => {
    setOpenCodeSkills((previous) => previous.map((skill, skillIndex) => skillIndex === index ? { ...skill, ...patch } : skill))
  }

  const addOpenCodeSkill = () => {
    setOpenCodeSkills((previous) => [...previous, { name: '', description: '', instructions: '' }])
  }

  const removeOpenCodeSkill = (index: number) => {
    setOpenCodeSkills((previous) => previous.filter((_, skillIndex) => skillIndex !== index))
  }

  const handleSaveOpenCodeCustomization = async () => {
    const customization = normalizeOpenCodeCustomization(openCodePlugins, openCodeSkills)
    const invalidPackage = customization.plugins.find((pluginPackage) => !NPM_PACKAGE_NAME_REGEX.test(pluginPackage))
    if (invalidPackage) {
      toasts.add({ title: `Invalid npm package name: ${invalidPackage}`, variant: 'error' })
      return
    }

    const incompleteSkill = customization.skills.find((skill) => !skill.name || !skill.description || !skill.instructions)
    if (incompleteSkill) {
      toasts.add({ title: 'Each OpenCode skill needs a name, description, and instructions', variant: 'error' })
      return
    }

    const skillNames = new Set<string>()
    const duplicateSkill = customization.skills.find((skill) => {
      const normalizedName = skill.name.toLowerCase()
      if (skillNames.has(normalizedName)) return true
      skillNames.add(normalizedName)
      return false
    })
    if (duplicateSkill) {
      toasts.add({ title: `Duplicate OpenCode skill name: ${duplicateSkill.name}`, variant: 'error' })
      return
    }

    setOpenCodeSaving(true)
    try {
      await authenticatedApi.setOpenCodeCustomization(customization)
      setOpenCodePlugins(customization.plugins.join('\n'))
      setOpenCodeSkills(customization.skills)
      toasts.add({ title: 'OpenCode settings saved', variant: 'success' })
    } catch (error) {
      console.error('Failed to save OpenCode customization:', error)
      toasts.add({ title: 'Failed to save OpenCode settings', variant: 'error' })
    } finally {
      setOpenCodeSaving(false)
    }
  }

  const displayAvatarUrl = localAvatarPreview || avatarUrl

  if (loading) {
    return (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center">
        <p className="text-[13px] tracking-[-0.25px] text-kumo-subtle">Loading profile…</p>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 pb-16 sm:px-10">
      <header className="px-1 pb-2 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Profile</h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          Manage your account details, avatar, and security.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-9">
        {/* Account */}
        <section className="flex flex-col gap-3">
          <SectionLabel>Account</SectionLabel>
          <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            {/* Avatar */}
            <div className="flex items-center gap-4 px-5 py-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarUploading}
                className="press group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-kumo-fill disabled:cursor-wait"
              >
                {displayAvatarUrl ? (
                  <img src={displayAvatarUrl} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  <User size={28} className="text-kumo-subtle" />
                )}
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <Camera size={18} className="text-white" />
                </div>
                {avatarUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-kumo-base/80">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
                  </div>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleAvatarUpload(file)
                  e.target.value = ''
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium tracking-[-0.25px] text-kumo-default">
                  {userInfo?.name}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                  Click the avatar to upload a new photo
                </p>
              </div>
            </div>

            {/* Display name */}
            <div className="flex items-end gap-2 px-5 py-4">
              <div className="min-w-0 flex-1">
                <FieldLabel>Display name</FieldLabel>
                {isEditingName ? (
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName()
                      if (e.key === 'Escape') handleCancelEdit()
                    }}
                    placeholder="Enter display name"
                    autoFocus
                    className={`mt-1.5 ${INPUT}`}
                  />
                ) : (
                  <p className="mt-1 text-[14px] tracking-[-0.25px] text-kumo-default">
                    {userInfo?.name}
                  </p>
                )}
              </div>
              {isEditingName ? (
                <>
                  <button
                    type="button"
                    onClick={handleSaveName}
                    disabled={!nameInput.trim()}
                    aria-label="Save display name"
                    className={PRIMARY_BTN}
                  >
                    <Check size={15} weight="bold" />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    aria-label="Cancel"
                    className={ICON_BTN}
                  >
                    <X size={15} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsEditingName(true)}
                  aria-label="Edit display name"
                  className={ICON_BTN}
                >
                  <Pencil size={14} />
                </button>
              )}
            </div>

            {/* User ID */}
            <div className="flex items-center gap-2 px-5 py-4">
              <div className="min-w-0 flex-1">
                <FieldLabel>User ID</FieldLabel>
                <p className="mt-1 truncate font-mono text-[12px] tracking-[-0.1px] text-kumo-subtle">
                  {userInfo?.id}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopyId}
                aria-label="Copy user ID"
                className={ICON_BTN}
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
        </section>

        {/* Usage & billing — only when the Cloudflare limits flow is enabled server-side */}
        <UsageSettings />

        {/* OpenCode */}
        <section className="flex flex-col gap-3">
          <SectionLabel>OpenCode</SectionLabel>
          <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
            <div className="flex flex-col gap-5">
              <div>
                <h3 className="text-[15px] font-medium tracking-[-0.25px] text-kumo-default">Code session customization</h3>
                <p className="mt-1 text-[12px] leading-5 tracking-[-0.1px] text-kumo-subtle">
                  These account settings apply only to your future OpenCode sessions. Existing or running sessions keep their current OpenCode setup.
                </p>
              </div>

              {openCodeLoading ? (
                <p className="text-[13px] tracking-[-0.25px] text-kumo-subtle">Loading OpenCode settings…</p>
              ) : (
                <>
                  {openCodeError && (
                    <div className="rounded-lg border border-kumo-danger bg-kumo-danger-tint px-3 py-2 text-[13px] text-kumo-danger">
                      {openCodeError}
                    </div>
                  )}

                  <div>
                    <FieldLabel>npm plugin packages</FieldLabel>
                    <textarea
                      value={openCodePlugins}
                      onChange={(event) => setOpenCodePlugins(event.target.value)}
                      placeholder="@example/opencode-plugin\nopencode-plugin-tools"
                      rows={4}
                      className={`mt-1.5 font-mono ${TEXTAREA}`}
                      aria-describedby="opencode-plugin-help"
                    />
                    <p id="opencode-plugin-help" className="mt-1 text-[12px] leading-5 tracking-[-0.1px] text-kumo-subtle">
                      Enter one npm package name per line. Plugins are trusted executable code with access to repositories in your sessions. Install only packages you trust.
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <FieldLabel>Skills</FieldLabel>
                      <p className="mt-1 text-[12px] leading-5 tracking-[-0.1px] text-kumo-subtle">Reusable OpenCode guidance available to future sessions.</p>
                    </div>
                    <button type="button" onClick={addOpenCodeSkill} className={`${PRIMARY_BTN} h-8 px-3`}>
                      <Plus size={14} weight="bold" /> Add skill
                    </button>
                  </div>

                  {openCodeSkills.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-kumo-line bg-kumo-tint/30 px-4 py-5 text-center text-[13px] text-kumo-subtle">
                      No custom skills yet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {openCodeSkills.map((skill, index) => (
                        <div key={index} className="rounded-lg border border-kumo-line bg-kumo-tint/20 p-4">
                          <div className="flex items-start gap-3">
                            <div className="grid flex-1 gap-3 sm:grid-cols-2">
                              <label>
                                <FieldLabel>Name</FieldLabel>
                                <input value={skill.name} onChange={(event) => updateOpenCodeSkill(index, { name: event.target.value })} className={`mt-1.5 ${INPUT}`} placeholder="review-code" />
                              </label>
                              <label>
                                <FieldLabel>Description</FieldLabel>
                                <input value={skill.description} onChange={(event) => updateOpenCodeSkill(index, { description: event.target.value })} className={`mt-1.5 ${INPUT}`} placeholder="When to use this skill" />
                              </label>
                            </div>
                            <button type="button" onClick={() => removeOpenCodeSkill(index)} aria-label={`Remove OpenCode skill ${skill.name || index + 1}`} className={ICON_BTN}>
                              <Trash size={14} />
                            </button>
                          </div>
                          <label className="mt-3 block">
                            <FieldLabel>Instructions</FieldLabel>
                            <textarea value={skill.instructions} onChange={(event) => updateOpenCodeSkill(index, { instructions: event.target.value })} rows={5} className={`mt-1.5 ${TEXTAREA}`} placeholder="Detailed instructions OpenCode should follow when this skill is used…" />
                          </label>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <button type="button" onClick={handleSaveOpenCodeCustomization} disabled={openCodeSaving} className={PRIMARY_BTN}>
                      <Check size={15} weight="bold" />
                      {openCodeSaving ? 'Saving…' : 'Save OpenCode settings'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Security — only for password accounts (hidden under CF Access or gatekeeper sign-in) */}
        {!CF_ACCESS_MODE && hasPassword === true && (
          <section className="flex flex-col gap-3">
            <SectionLabel>Security</SectionLabel>
            <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
              <div className="flex max-w-sm flex-col gap-4">
                <PasswordField
                  label="Current password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                />

                <PasswordField
                  label="New password"
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="Enter new password"
                  description="Must be at least 8 characters"
                  autoComplete="new-password"
                />

                <PasswordField
                  label="Confirm new password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  error={passwordError}
                />

                <div className="pt-1">
                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={passwordLoading || !currentPassword || !newPassword || !confirmPassword}
                    className={PRIMARY_BTN}
                  >
                    <Lock size={14} weight="bold" />
                    {passwordLoading ? 'Changing…' : 'Change password'}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
