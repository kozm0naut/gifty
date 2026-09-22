export type CreateGiftItemDto = {
  name: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
};

export function validateCreateGiftItem(dto: CreateGiftItemDto): string | null {
  if (!dto.name || dto.name.trim().length === 0) {
    return 'Gift item name is required';
  }
  // FR-003: quantity is optional; when supplied it must be a positive integer.
  if (dto.quantity !== undefined && (typeof dto.quantity !== 'number' || dto.quantity < 1)) {
    return 'Quantity must be at least 1';
  }
  if (dto.unitPrice !== undefined && (typeof dto.unitPrice !== 'number' || dto.unitPrice < 0)) {
    return 'Unit price must be a non-negative number';
  }
  return null;
}
