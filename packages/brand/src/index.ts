export { AppLogo, type AppLogoAnimation, type AppLogoProps, type AppLogoVariant } from "./AppLogo";
export * from "./bot-avatar-shapes";
export {
  type MobilePlatformLogoVariant,
  PlatformLogo,
  type PlatformLogoProps,
  type PlatformLogoVariant,
} from "./PlatformLogo";
export { ProviderLogo, type ProviderLogoProps, type ProviderLogoVariant } from "./ProviderLogo";
// The canvas mascot engine has its own exported subpath. Re-exporting it here made every AppLogo
// and ProviderLogo import pull the full renderer into the initial application chunk, defeating the
// idle loader in BotCanvasAvatar.
