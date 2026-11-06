interface ChainLogoProps {
  name: string
  symbol?: string
  className?: string
  size?: number
}

export function ChainLogo({ name, symbol, className = '', size = 28 }: ChainLogoProps) {
  const lowerName = name.toLowerCase()
  const lowerSymbol = (symbol || '').toLowerCase()

  // Base
  if (lowerName.includes('base')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Base"
      >
        <circle cx="16" cy="16" r="16" fill="#0052FF" />
        <path
          d="M16 6C10.477 6 6 10.477 6 16C6 21.523 10.477 26 16 26C21.246 26 25.535 21.967 25.962 16.833H16.5V15.167H25.962C25.535 10.033 21.246 6 16 6Z"
          fill="white"
        />
      </svg>
    )
  }

  // Solana
  if (lowerName.includes('solana') || lowerSymbol === 'sol') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Solana"
      >
        <circle cx="16" cy="16" r="16" fill="#141026" />
        <path
          d="M8.5 21.8C8.7 21.6 9 21.5 9.3 21.5H22.7C23.2 21.5 23.5 22.1 23.1 22.5L20.8 24.8C20.6 25 20.3 25.1 20 25.1H6.6C6.1 25.1 5.8 24.5 6.2 24.1L8.5 21.8Z"
          fill="url(#sol_g1)"
        />
        <path
          d="M8.5 14.5C8.7 14.3 9 14.2 9.3 14.2H22.7C23.2 14.2 23.5 14.8 23.1 15.2L20.8 17.5C20.6 17.7 20.3 17.8 20 17.8H6.6C6.1 17.8 5.8 17.2 6.2 16.8L8.5 14.5Z"
          fill="url(#sol_g2)"
        />
        <path
          d="M20.8 7.2C20.6 7 20.3 6.9 20 6.9H6.6C6.1 6.9 5.8 7.5 6.2 7.9L8.5 10.2C8.7 10.4 9 10.5 9.3 10.5H22.7C23.2 10.5 23.5 9.9 23.1 9.5L20.8 7.2Z"
          fill="url(#sol_g3)"
        />
        <defs>
          <linearGradient id="sol_g1" x1="6" y1="23.3" x2="23.5" y2="23.3" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00FFA3" />
            <stop offset="1" stopColor="#DC1FFF" />
          </linearGradient>
          <linearGradient id="sol_g2" x1="6" y1="16" x2="23.5" y2="16" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00FFA3" />
            <stop offset="1" stopColor="#DC1FFF" />
          </linearGradient>
          <linearGradient id="sol_g3" x1="6" y1="8.7" x2="23.5" y2="8.7" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00FFA3" />
            <stop offset="1" stopColor="#DC1FFF" />
          </linearGradient>
        </defs>
      </svg>
    )
  }

  // Arbitrum
  if (lowerName.includes('arbitrum')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Arbitrum"
      >
        <circle cx="16" cy="16" r="16" fill="#28A0F0" />
        <path
          d="M16.1 7.2L20.4 14.4L16.1 21.6L11.8 14.4L16.1 7.2Z"
          fill="white"
        />
        <path
          d="M21.5 16.3L24 20.5C24.3 21 24 21.6 23.4 21.6H18.7L21.5 16.3Z"
          fill="#213147"
        />
        <path
          d="M10.5 16.3L7.7 20.5C7.4 21 7.7 21.6 8.3 21.6H13.3L10.5 16.3Z"
          fill="white"
        />
      </svg>
    )
  }

  // Ethereum
  if (lowerName.includes('ethereum') || lowerSymbol === 'eth') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Ethereum"
      >
        <circle cx="16" cy="16" r="16" fill="#627EEA" />
        <path
          d="M16 5V13.8L22.5 16.7L16 5Z"
          fill="white"
          fillOpacity="0.6"
        />
        <path
          d="M16 5L9.5 16.7L16 13.8V5Z"
          fill="white"
        />
        <path
          d="M16 21.9V27L22.5 18L16 21.9Z"
          fill="white"
          fillOpacity="0.6"
        />
        <path
          d="M16 27V21.9L9.5 18L16 27Z"
          fill="white"
        />
        <path
          d="M16 20.6L22.5 16.7L16 13.8V20.6Z"
          fill="white"
          fillOpacity="0.2"
        />
        <path
          d="M9.5 16.7L16 20.6V13.8L9.5 16.7Z"
          fill="white"
          fillOpacity="0.6"
        />
      </svg>
    )
  }

  // Bitcoin
  if (lowerName.includes('bitcoin') || lowerSymbol === 'btc') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Bitcoin"
      >
        <circle cx="16" cy="16" r="16" fill="#F7931A" />
        <path
          d="M22.3 13.4C22.6 11.4 21.3 10.3 19.3 9.6L20 6.8L18.3 6.4L17.6 9.1C17.2 9 16.7 8.9 16.3 8.8L17 6.1L15.3 5.7L14.6 8.4C14.2 8.3 13.9 8.2 13.5 8.1L13.5 8.1L11.2 7.5L10.7 9.3C10.7 9.3 12 9.6 11.9 9.6C12.6 9.8 12.8 10.3 12.7 10.7L11.7 14.6C11.8 14.6 11.9 14.7 12 14.7L11.8 14.6L10.5 19.8C10.4 20.2 10.1 20.5 9.4 20.3C9.5 20.4 8.2 20.1 8.2 20.1L7.3 22.1L9.5 22.7C9.9 22.8 10.3 22.9 10.7 23L10 25.8L11.7 26.2L12.4 23.4C12.8 23.5 13.2 23.6 13.6 23.7L12.9 26.5L14.6 26.9L15.3 24.1C18.2 24.7 20.4 24.5 21.3 21.8C22 19.7 21.3 18.5 19.8 17.7C20.9 17.1 21.8 15.9 22.3 13.4ZM18.7 19.8C18.2 21.8 14.8 20.7 13.6 20.4L14.7 16C15.9 16.3 19.2 17.2 18.7 19.8ZM19.3 13.3C18.9 15.1 16.1 14.2 15.1 13.9L16 10C17 10.2 19.7 11.1 19.3 13.3Z"
          fill="white"
        />
      </svg>
    )
  }

  // Sui
  if (lowerName.includes('sui')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Sui"
      >
        <circle cx="16" cy="16" r="16" fill="#4DA2FF" />
        <path
          d="M16 6C13.2 10.2 9.5 15.6 9.5 19.4C9.5 23 12.4 26 16 26C19.6 26 22.5 23 22.5 19.4C22.5 15.6 18.8 10.2 16 6Z"
          fill="white"
        />
        <path
          d="M16 11C14.2 14.2 12.2 17.6 12.2 20C12.2 22.1 13.9 23.8 16 23.8C18.1 23.8 19.8 22.1 19.8 20C19.8 17.6 17.8 14.2 16 11Z"
          fill="#4DA2FF"
          fillOpacity="0.3"
        />
      </svg>
    )
  }

  // Polygon
  if (lowerName.includes('polygon') || lowerSymbol === 'pol' || lowerSymbol === 'matic') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Polygon"
      >
        <circle cx="16" cy="16" r="16" fill="#8247E5" />
        <path
          d="M20.9 14.1C20.3 13.7 19.5 13.7 18.9 14.1L16.9 15.2L15.3 16.1L13.3 17.2C12.7 17.6 11.9 17.6 11.3 17.2L9.7 16.3C9.1 16 8.7 15.3 8.7 14.6V12.7C8.7 12 9.1 11.4 9.7 11L11.3 10.1C11.9 9.7 12.7 9.7 13.3 10.1L14.9 11C15.5 11.3 15.9 12 15.9 12.7V13.8L17.5 12.9V11.8C17.5 11.1 17.1 10.5 16.5 10.1L14.9 9.2C13.7 8.5 12.1 8.5 10.9 9.2L9.3 10.1C8.1 10.8 7.3 12.1 7.3 13.5V15.4C7.3 16.8 8.1 18.1 9.3 18.8L10.9 19.7C12.1 20.4 13.7 20.4 14.9 19.7L16.9 18.6L18.5 17.7L20.5 16.6C21.1 16.2 21.9 16.2 22.5 16.6L24.1 17.5C24.7 17.8 25.1 18.5 25.1 19.2V21.1C25.1 21.8 24.7 22.4 24.1 22.8L22.5 23.7C21.9 24.1 21.1 24.1 20.5 23.7L18.9 22.8C18.3 22.5 17.9 21.8 17.9 21.1V20L16.3 20.9V22C16.3 22.7 16.7 23.3 17.3 23.7L18.9 24.6C20.1 25.3 21.7 25.3 22.9 24.6L24.5 23.7C25.7 23 26.5 21.7 26.5 20.3V18.4C26.5 17 25.7 15.7 24.5 15L22.9 14.1C22.3 13.7 21.5 13.7 20.9 14.1Z"
          fill="white"
        />
      </svg>
    )
  }

  // Optimism
  if (lowerName.includes('optimism') || lowerSymbol === 'op') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Optimism"
      >
        <circle cx="16" cy="16" r="16" fill="#FF0420" />
        <path
          d="M11 11.2C8.8 11.2 7 13.3 7 16C7 18.7 8.8 20.8 11 20.8C13.2 20.8 15 18.7 15 16C15 13.3 13.2 11.2 11 11.2ZM11 18.6C9.9 18.6 9 17.4 9 16C9 14.6 9.9 13.4 11 13.4C12.1 13.4 13 14.6 13 16C13 17.4 12.1 18.6 11 18.6ZM17 11.4H21C23.2 11.4 25 12.9 25 14.9C25 16.9 23.2 18.4 21 18.4H19V20.8H17V11.4ZM19 16.4H20.8C21.8 16.4 22.8 15.8 22.8 14.9C22.8 14 21.8 13.4 20.8 13.4H19V16.4Z"
          fill="white"
        />
      </svg>
    )
  }

  // Avalanche
  if (lowerName.includes('avalanche') || lowerSymbol === 'avax') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Avalanche"
      >
        <circle cx="16" cy="16" r="16" fill="#E84142" />
        <path
          d="M17.4 7.6C16.8 6.5 15.2 6.5 14.6 7.6L7.2 20.4C6.6 21.5 7.4 22.9 8.6 22.9H13.2C13.8 22.9 14.4 22.6 14.7 22L16 19.7L17.3 22C17.6 22.6 18.2 22.9 18.8 22.9H23.4C24.6 22.9 25.4 21.5 24.8 20.4L17.4 7.6ZM16 11.8L19.5 18H12.5L16 11.8Z"
          fill="white"
        />
      </svg>
    )
  }

  // Tron
  if (lowerName.includes('tron') || lowerSymbol === 'trx') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Tron"
      >
        <circle cx="16" cy="16" r="16" fill="#FF0013" />
        <path
          d="M8.2 8.5L23.8 10.3L19.2 23.5L8.2 8.5ZM19.2 12.1L11.5 11.2L17.1 18.8L19.2 12.1Z"
          fill="white"
        />
      </svg>
    )
  }

  // TON
  if (lowerName.includes('ton')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="TON"
      >
        <circle cx="16" cy="16" r="16" fill="#0098EA" />
        <path
          d="M16 6.8L6.8 21.4C6.4 22.1 6.9 23 7.7 23H24.3C25.1 23 25.6 22.1 25.2 21.4L16 6.8ZM16 10.4L22.2 20.8H9.8L16 10.4Z"
          fill="white"
        />
      </svg>
    )
  }

  // Dogecoin
  if (lowerName.includes('doge')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Dogecoin"
      >
        <circle cx="16" cy="16" r="16" fill="#C2A633" />
        <path
          d="M12.5 9H17.2C20.6 9 23.2 11.4 23.2 15.5C23.2 19.6 20.6 22 17.2 22H12.5V9ZM10.5 14.5H15.8V16.5H10.5V14.5ZM14.8 11.2V19.8H17.2C19.3 19.8 20.9 18.2 20.9 15.5C20.9 12.8 19.3 11.2 17.2 11.2H14.8Z"
          fill="white"
        />
      </svg>
    )
  }

  // Stellar
  if (lowerName.includes('stellar') || lowerSymbol === 'xlm') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="Stellar"
      >
        <circle cx="16" cy="16" r="16" fill="#14B6EB" />
        <path
          d="M23.2 11.2C21.4 9.4 18.8 8.4 16 8.4C13.2 8.4 10.6 9.4 8.8 11.2L7.5 9.9C9.7 7.7 12.7 6.4 16 6.4C19.3 6.4 22.3 7.7 24.5 9.9L23.2 11.2ZM8.8 20.8C10.6 22.6 13.2 23.6 16 23.6C18.8 23.6 21.4 22.6 23.2 20.8L24.5 22.1C22.3 24.3 19.3 25.6 16 25.6C12.7 25.6 9.7 24.3 7.5 22.1L8.8 20.8ZM16 11.2C13.3 11.2 11.2 13.3 11.2 16C11.2 18.7 13.3 20.8 16 20.8C18.7 20.8 20.8 18.7 20.8 16C20.8 13.3 18.7 11.2 16 11.2Z"
          fill="white"
        />
      </svg>
    )
  }

  // NEAR
  if (lowerName.includes('near')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="NEAR"
      >
        <circle cx="16" cy="16" r="16" fill="#000000" />
        <path
          d="M10.2 22.8V9.2H12.8L19.5 18.6V9.2H21.8V22.8H19.2L12.5 13.4V22.8H10.2Z"
          fill="white"
        />
      </svg>
    )
  }

  // USDC / Tether stablecoin fallback
  if (lowerSymbol === 'usdc') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="USDC"
      >
        <circle cx="16" cy="16" r="16" fill="#2775CA" />
        <path
          d="M16 7C11 7 7 11 7 16C7 21 11 25 16 25C21 25 25 21 25 16C25 11 21 7 16 7ZM16 23.2C12 23.2 8.8 20 8.8 16C8.8 12 12 8.8 16 8.8C20 8.8 23.2 12 23.2 16C23.2 20 20 23.2 16 23.2Z"
          fill="white"
          fillOpacity="0.5"
        />
        <path
          d="M16.8 13.2C15.6 12.9 14.5 12.8 14.5 12C14.5 11.3 15.2 10.9 16.1 10.9C17 10.9 17.6 11.3 17.9 11.9H19.5C19.2 10.4 18.1 9.4 16.8 9.2V8H15.2V9.2C13.8 9.5 12.7 10.6 12.7 12C12.7 13.9 14.4 14.4 15.6 14.7C16.8 15 17.5 15.3 17.5 16.1C17.5 16.9 16.7 17.3 15.7 17.3C14.6 17.3 13.8 16.7 13.5 15.9H11.9C12.3 17.6 13.5 18.6 15.2 18.9V20.1H16.8V18.9C18.2 18.6 19.3 17.5 19.3 16C19.3 14 17.7 13.4 16.8 13.2Z"
          fill="white"
        />
      </svg>
    )
  }

  if (lowerSymbol === 'usdt') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-label="USDT"
      >
        <circle cx="16" cy="16" r="16" fill="#26A17B" />
        <path
          d="M17.5 14.8V12.7H22.4V9.5H9.6V12.7H14.5V14.8C10.7 15 7.8 16.2 7.8 17.6C7.8 19 10.7 20.2 14.5 20.4V24.5H17.5V20.4C21.3 20.2 24.2 19 24.2 17.6C24.2 16.2 21.3 15 17.5 14.8ZM16 19.2C12.8 19.2 10.2 18.4 10.2 17.5C10.2 16.6 12.8 15.8 16 15.8C19.2 15.8 21.8 16.6 21.8 17.5C21.8 18.4 19.2 19.2 16 19.2Z"
          fill="white"
        />
      </svg>
    )
  }

  // Generic fallback blockchain icon
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label={name}
    >
      <circle cx="16" cy="16" r="16" fill="#64748B" />
      <circle cx="16" cy="16" r="6" stroke="white" strokeWidth="2" />
      <path d="M16 6V10M16 22V26M6 16H10M22 16H26" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
