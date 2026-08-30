export function deleteConfirmationMessage(names: string[]) {
  const subject = names.length === 1 ? 'this item' : `these ${names.length} items`
  return `Move ${subject} to Trash?\n\n${names.map(name => `• ${name}`).join('\n')}`
}
