module.exports = function greetingLoader(source) {
	return `export const message = ${JSON.stringify(source.trim())};`;
};
