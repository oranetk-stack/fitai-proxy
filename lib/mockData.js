export const MOCK_PARSED_ITEMS = [
  { name: "canned chickpeas", confidence: 0.94 },
  { name: "brown rice", confidence: 0.87 },
  { name: "fresh spinach", confidence: 0.81 }
];

export const MOCK_RECIPES = [
  {
    title: "Chickpea & Spinach Pilaf",
    description: "Quick pilaf with protein-rich chickpeas and vibrant spinach.",
    calories: 480,
    macros: { protein: 22, carbs: 65, fat: 12 },
    ingredients: [
      { name: "canned chickpeas", quantity: "1 can (240g drained)" },
      { name: "brown rice", quantity: "1 cup (200g) cooked" },
      { name: "spinach", quantity: "2 cups (60g)" }
    ],
    steps: [
      "Rinse and drain chickpeas.",
      "Cook rice according to package instructions.",
      "Sauté spinach until wilted, combine with rice and chickpeas, season to taste."
    ],
    source: "mock"
  }
];

export const MOCK_CHAT_REPLY = {
  reply:
    "To lose ~0.5 kg per week you generally need a calorie deficit of ~500 kcal/day. Based on your profile I recommend a ~1500–1700 kcal/day target. Would you like a 7-day meal plan using your pantry items?",
  suggestedActions: ["Generate a 7-day plan", "Adjust calorie target"],
  caution:
    "This is general advice. Consult a healthcare professional for personalized medical guidance."
};

export const MOCK_BARCODE = {
  productName: "Whole Grain Pasta",
  servingSize: "56 g",
  calories: 200,
  macros: { protein: 7, carbs: 42, fat: 1.5 },
  brand: "Brand X",
  source: "mock"
};
