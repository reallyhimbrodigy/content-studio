
import { useState } from 'react';

const EXAMPLE_VIBES = [
  "punchy TikTok with fast cuts and meme SFX",
  "smooth cinematic Instagram Reels",
  "chaotic comedy with zooms and shake effects",
  "minimal aesthetic with slow pans",
  "high-energy fitness content with motivational vibes",
  "educational explainer with clean captions",
];

export default function VibeInput({ onSubmit, disabled = false }) {
  const [vibe, setVibe] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState([]);

  const handleInputChange = (e) => {
    const value = e.target.value;
    setVibe(value);

    if (value.trim().length > 0) {
      const filtered = EXAMPLE_VIBES.filter((example) =>
        example.toLowerCase().includes(value.toLowerCase())
      );
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleSuggestionClick = (suggestion) => {
    setVibe(suggestion);
    setShowSuggestions(false);
  };

  const handleSubmit = () => {
    if (vibe.trim() && !disabled) {
      onSubmit(vibe.trim());
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto space-y-4">
      <div className="relative">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Describe your desired vibe
        </label>
        <textarea
          value={vibe}
          onChange={handleInputChange}
          onFocus={() => {
            if (vibe.trim().length > 0 && filteredSuggestions.length > 0) {
              setShowSuggestions(true);
            }
          }}
          placeholder="e.g., punchy TikTok with fast cuts and meme SFX"
          disabled={disabled}
          rows={4}
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed resize-none"
        />

        {showSuggestions && filteredSuggestions.length > 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {filteredSuggestions.map((suggestion, index) => (
              <button
                key={index}
                onClick={() => handleSuggestionClick(suggestion)}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-b-0"
              >
                <p className="text-sm text-gray-700">{suggestion}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        <p className="font-medium">Example vibes:</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_VIBES.slice(0, 3).map((example, index) => (
            <button
              key={index}
              onClick={() => handleSuggestionClick(example)}
              disabled={disabled}
              className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-full text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={disabled || !vibe.trim()}
        className="w-full px-6 py-4 bg-black text-white font-semibold rounded-lg hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        Generate Edited Video
      </button>
    </div>
  );
}
