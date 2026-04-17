export function transportEmoji(mode: string): string {
  switch (mode) {
    case "walking":
      return "🚶";
    case "bike":
      return "🚲";
    case "scooter":
      return "🛴";
    case "car":
      return "🚗";
    case "other_vehicle":
      return "🚙";
    default:
      return "·";
  }
}
