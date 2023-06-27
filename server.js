b// Import required modules
const express = require("express");
const axios = require("axios");
const { Configuration, OpenAIApi } = require("openai"); 

const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser"); 

const cheerio = require("cheerio");
const natural = require("natural");
const pos = require("pos"); 

// Set up the Express server
const app = express(); 

const OPENAI_API_KEY = "";
const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
}); 

const openai = new OpenAIApi(configuration); 

app.use(
  cors({
    origin: "https://review.land/backapi/submit",
    credentials: true,
  })
); 

// ... other middleware and route handlers 

// Enable CORS preflight requests
app.options("*", cors()); 

app.use(bodyParser.json()); 

// Connect to MongoDB
mongoose.connect("mongodb://localhost/reviewland", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const db = mongoose.connection; 

db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("Connected to MongoDB");
}); 

// Define the Product schema
const productSchema = new mongoose.Schema({
  title: String,
  keyword: String,
  category: String,
  articalSummary: String,
  articleImage: String,
  products: [],
  generatedTimestamp: String,
  meta: {
    metaDescription: String,
    metaKeywords: String,
    metaSchema: String,
  },
}); 

const Product = mongoose.model("Product", productSchema); 

// ... 

// Define a route for processing the keyword array
app.post("/submit", async (req, res) => {
  try {
    const keywords = req.body; 

    const results = await Promise.all(
      keywords.map(async ({ keyword, urls }) => {
        const filterUrls = urls.filter((element) => element !== "");
        console.log(keyword, "Data: ", filterUrls); 

        try {
          const existingRecord = await Product.findOne({ keyword }); 

          if (existingRecord) {
            await Product.deleteOne({ keyword });
            console.log("Record Already in DB, Delete the Old One");
          } 

          const articleTitle = await generateTitle(keyword);
          const articleImage = await generateArticleImage(keyword);
          const articalSummary = await generateArticleSummary(keyword);
          const tempArticleCategory = await generateCategory(keyword);
          const Spacecategory = tempArticleCategory.split(":")[1];
          const category = Spacecategory.map((item) => item.trim());


          // Generate META 

          const metaDescription = await generateShortDes(keyword);
          const metaKeywords = await generateKeywords(keyword);
          const metaSchema = await generateSchema(keyword); 

          const products = await searchProducts(filterUrls);
          console.log(`Products of ${keyword}: `, products); 

          let AllProducts = []; 

          const processedProducts = await Promise.all(
            products.map(async (asin) => {
              try {
                const timestamp = new Date().toLocaleString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                });
                const productDetails = await getProductDetails(asin);
                const productReviews = await getProductReviews(asin);
                const productPriceHistory = await getPriceHistory(asin);
                const CategoryScore = await generateCategoryScore(
                  productDetails.title
                );
                // console.log(
                //   `The ASIN: ${asin} the details are: ${productDetails}`
                // );
                // console.log(
                //   `The ASIN: ${asin} the Reviews are: ${productReviews}`
                // );
                // console.log(
                //   `The ASIN: ${asin} the PRICE HISTORY are: ${productPriceHistory}`
                // ); 

                const summary = await generateSummary(
                  productDetails.description || " ",
                  productReviews
                ); 

                let pro = {
                  asin,
                  title: productDetails.title,
                  categoryScore: CategoryScore,
                  expended: false,
                  detail: productDetails,
                  thumbnail: productDetails.mainImage,
                  reviews: productReviews,
                  url: productDetails.url,
                  summary,
                  price_history: productPriceHistory,
                }; 

                if (pro.price_history.data != null) {
                  pro.price_history.data.price_detail.price_current_timestamp =
                    timestamp;
                } 

                AllProducts.push(pro);
              } catch (error) {
                console.error(
                  `Error processing product with ASIN ${asin}:`,
                  error
                );
                return null;
              }
            })
          ); 

          const timestamp = new Date().toLocaleString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }); 

          let title = articleTitle.replace(/-/g, " ");
          let makeObj = {
            title,
            keyword,
            category,
            articleImage,
            articalSummary,
            products: AllProducts,
            generatedTimestamp: timestamp,
            meta: {
              metaDescription,
              metaKeywords,
              metaSchema,
            },
          }; 

          return makeObj;
        } catch (error) {
          console.error(`Error processing keyword "${keyword}":`, error);
          res.json({ error: `Before DATA Addition ${error.data.message}` });
        }
      })
    ); 

    // console.log("WITHOUT FILTER", results); 

    let productWithOutFilter = results;
    const filteredArray = productWithOutFilter.map((obj) => ({
      ...obj,
      products: obj.products.filter(
        (product) => product.thumbnail !== "" && product.title !== ""
      ),
    })); 

    // Save the results to MongoDB
    let a = Product.insertMany(filteredArray);
    console.log("Record Added !");
    res.json(results);
  } catch (error) {
    console.error("While Saving Data into DB:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing the keywords." });
  }
}); 

// Unsplash API
// const accessKey = ""; // Replace with your Unsplash API access key
// const baseUrl = "https://api.unsplash.com/search/photos"; 

// Search products on Amazon using RapidAPI
async function searchProducts(urls) {
  const allAmazonLinks = []; 

  // Iterate through each URL
  for (const url of urls) {
    try {
      const response = await axios.get(url);
      const $ = cheerio.load(response.data); 

      // Find all anchor tags on the page
      const anchorTags = $("a");
      // Iterate through each anchor tag
      let count = 0;
      anchorTags.each((index, element) => {
        const href = $(element).attr("href"); 

        // Check if the link contains "amazon.com"
        if (
          href &&
          href.includes("amazon.com") &&
          !href.includes("amazon.com/gp")
        ) {
          count++;
          const parsedUrl = new URL(href);
          parsedUrl.search = ""; // Remove query parameters
          const formattedUrl = parsedUrl.href; 

          // / Use regex to extract the secret code
          const match = formattedUrl.match(/dp\/([A-Za-z0-9]{10})/); 

          allAmazonLinks.push(match[1]);
        } 

        // console.log(`${url} is => ${count}`)
      });
    } catch (error) {
      console.error(`Error fetching URL ${url}: ${error}`);
    }
  } 

  const asinCount = {}; 

  for (let i = 0; i < allAmazonLinks.length; i++) {
    const asin = allAmazonLinks[i];
    if (asinCount[asin]) {
      asinCount[asin]++;
    } else {
      asinCount[asin] = 1;
    }
  } 

  // Sort the ASINs based on their occurrence count
  const sortedAsins = Object.keys(asinCount).sort(
    (a, b) => asinCount[b] - asinCount[a]
  ); 

  // Get the ASINs that appear more than once
  const duplicateAsins = sortedAsins.filter((asin) => asinCount[asin] > 1); 

  // Get the top 15 products
  const topProducts = [];
  let i = 0;
  while (topProducts.length < 15 && i < duplicateAsins.length) {
    topProducts.push(duplicateAsins[i]);
    i++;
  } 

  // If still fewer than 15 products, add top products from the original array
  if (topProducts.length < 15) {
    const remainingCount = 15 - topProducts.length;
    for (let j = 0; j < remainingCount; j++) {
      if (
        j < allAmazonLinks.length &&
        !topProducts.includes(allAmazonLinks[j])
      ) {
        topProducts.push(allAmazonLinks[j]);
      }
    }
  } 

  return topProducts;
} 

// Get product details using RapidAPI
async function getProductDetails(asin, retries = 3) {
  console.log("++++++++++++++++++++++++++++++");
  console.log("Seaching the product detail", asin); 

  try {
    const options = {
      method: "GET",
      url: "https://amazon-product-reviews-keywords.p.rapidapi.com/product/details",
      params: {
        asin,
        country: "US",
      },
      headers: {
        "X-RapidAPI-Key": "",
        "X-RapidAPI-Host": "amazon-product-reviews-keywords.p.rapidapi.com",
      },
    }; 

    const response = await axios.request(options);
    let DescriptionAndImage = {
      title: response.data.product.title,
      description: response.data.product.description,
      url: response.data.product.url,
      mainImage: response.data.product.main_image,
    };
    return DescriptionAndImage;
  } catch (error) {
    console.error("MASLAH HO RAHA retrieving product details:", error); 

    // Retry logic
    if (retries > 0) {
      console.log(`Retrying in 2 seconds... (Attempts left: ${retries})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return getProductDetails(asin, retries - 1);
    } else {
      console.error(
        "Failed to retrieve product details after multiple retries."
      );
    }
  }
} 

// Get product reviews using RapidAPI
async function getProductReviews(asin) {
  console.log("Searching the Reviews", asin);
  const options = {
    method: "GET",
    url: "https://amazon-product-reviews-keywords.p.rapidapi.com/product/reviews",
    params: {
      asin,
      country: "US",
      top: "0",
    },
    headers: {
      "X-RapidAPI-Key": "",
      "X-RapidAPI-Host": "amazon-product-reviews-keywords.p.rapidapi.com",
    },
  }; 

  const response = await axios.request(options);
  return response.data;
} 

// Generate Image for an Artical
async function generateArticleImage(keyword) {
  const accessKey = ""; // Replace with your Unsplash API access key
  const baseUrl = "https://api.unsplash.com/search/photos"; 

  try {
    // Tokenize the sentence into individual words
    const words = new pos.Lexer().lex(keyword); 

    // Perform part-of-speech tagging
    const tagger = new pos.Tagger();
    const taggedWords = tagger.tag(words); 

    // Extract the subject (noun) from the tagged words
    const subjects = taggedWords
      .filter((taggedWord) => {
        const tag = taggedWord[1];
        return tag.startsWith("NN"); // Filter only nouns (NN, NNS, NNP, NNPS)
      })
      .map((taggedWord) => taggedWord[0]); 

    const NounKeywords = subjects.join(" ");
    const response = await axios.get(baseUrl, {
      params: {
        query: NounKeywords,
        per_page: 1,
        client_id: accessKey,
        orientation: "landscape",
        order_by: "relevant",
      },
    }); 

    const firstResult = response.data.results[0];
    const imageUrl = firstResult.urls.regular; 

    return imageUrl;
  } catch (error) {
    console.error("Error searching for images:", error);
    return null;
  }
} 

// Get price history using RapidAPI
async function getPriceHistory(asin) {
  const options = {
    method: "GET",
    url: "https://amazon-historical-price.p.rapidapi.com/api/sc/amazon/historical_price",
    params: {
      item_url: `https://www.amazon.com/dp/${asin}`,
    },
    headers: {
      "X-RapidAPI-Key": "",
      "X-RapidAPI-Host": "amazon-historical-price.p.rapidapi.com",
    },
  }; 

  const response = await axios.request(options); 

  return response.data;
} 

// GPT-4 API Requests 

// Generate a unique title for a keyword using OpenAI API
async function generateTitle(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `Write a catchy, clickbait title for ${keyword} never use "-" characters in title and that contain best highly searched keywords in google so the title can rank in top 3,4 result. also must use "${keyword}" 2 times in title. Title must not be more than 80 characters.`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content.trim();
} 

// Generate a unique Summery for a keyword using OpenAI API
async function generateArticleSummary(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `write an article about "${keyword}" for my blogging never include Title heading website where I suggest the best products related to "${keyword}" but don't mention any products because i show them the products from the database also  not mention any points in bullets just explain as much thertically explain, write about "why, how, when" type of headings if it is relatable and write in multiple paragraphs not in paragraph points and each paragraph is separated by * character.`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content;
} 

// Generate a unique Summery for a keyword using OpenAI API
async function generateCategory(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `I write an article about "${keyword}" give me the category only from this list [Technology, Pets, Culinary, Outdoor, Automotive, Home, Beauty, Fashion ] and give the closest one, the format must be Category:category_name format`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content;
} 

// Generate a unique title for a keyword using OpenAI API
async function generateCategoryScore(productName) {
  const messages = [
    { role: "user", content: productName },
    {
      role: "assistant",
      content: `Please provide a product review for ${productName} in the following five categories, each scored out of 2 points:
      1. Functionality: Does the product perform as expected?
      2. Aesthetics: Is the design appealing and suitable for its intended use?
      3. Reliability: is the product built well, will it last a long time?
      4. Value for Money: Does the price match the quality and features of the product?
      5. Innovativeness: Does the product offer something unique or inventive compared to other similar products on the market?
      
      
      
      Please provide total category score in simple Score:score_number/10 format just`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  let res = completion.data.choices[0].message.content; 

  const regex = /(Score|Total Score|Final Score): (\d\/\d\d)/;
  const match = res.match(regex); 

  if (match) {
    console.log(`MARWAA LOO ${res}: Filter hai: ${match}`);
    const totalScore = match[2];
    return totalScore;
  } else {
    return "Not Available";
  }
} 

async function generateSummary(description, reviews) {
  const MAX_REQUESTS = 5; // Maximum number of requests to attempt
  const BACKOFF_FACTOR = 2; // Backoff factor for exponential backoff
  const INITIAL_DELAY = 3000; // Initial delay before the first retry in milliseconds 

  console.log("Generate Description");
  // Make a POST request to the GPT API with the product description and reviews
  // Parse and return the generated summary 

  // Helper function to handle exponential backoff
  const handleExponentialBackoff = async (requestFunction) => {
    let delay = INITIAL_DELAY;
    let attempt = 1; 

    while (attempt <= MAX_REQUESTS) {
      try {
        return await requestFunction();
      } catch (error) {
        console.error(`Request failed (attempt ${attempt}): ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= BACKOFF_FACTOR;
        attempt++;
      }
    } 

    throw new Error(`Maximum number of retries (${MAX_REQUESTS}) exceeded.`);
  }; 

  const filteredReviews = reviews.reviews; 

  const positiveReviews = filteredReviews.filter(
    (review) => review.rating >= 4
  );
  const negativeReviews = filteredReviews.filter(
    (review) => review.rating <= 3
  ); 

  const onlyPositiveReviews = positiveReviews.map((obj) => obj.review);
  const allPositiveReviews = onlyPositiveReviews.flat(); 

  const onlyNegativeReviews = negativeReviews.map((obj) => obj.review);
  const allNegativeReviews = onlyNegativeReviews.flat(); 

  var messages = []; 

  // Generate product summary
  var input = `
  Give summer for the product in paragraph and product description is (${description}) must exclude and not use any of these of words in this array [SEO, SEO Optimize, Ranking, Google Ranking, Search Rankings, AI, Generated by AI, Optimized by AI, Detectable, Not Detectable by AI] and I have multiple positive reviews of customer in array (${allPositiveReviews}) t negative reviews are (${allNegativeReviews})  make an attractive details summary of that product must use the positive review to show the positive feature of the product (make sure not in points) and if there is a negative review just write the negative review in positive sentiment. must follow the rules like "use highly searched keywords that ranked on top of Google searches and are related to this product" and "the description has a maximum of 40 characters" and "the whole description is fully SEO optimized" and (MOST important.) "Rewrite the content so it is not detected as AI content by the AI content detector by following all key attribute that is undetectable being written by AI."`;
  messages.push({ role: "user", content: description });
  messages.push({ role: "assistant", content: input }); 

  const requestSummary = () =>
    openai.createChatCompletion({
      model: "gpt-4",
      messages: messages,
    }); 

  const completionSummary = await handleExponentialBackoff(requestSummary); 

  let productSummary = completionSummary.data.choices[0].message.content; 

  messages = []; 

  // Generate pros from positive reviews
  input = `I have a array of my customers positive reviews ${allPositiveReviews}
  now write down the features of this products in points, points are to the point and not use any of these of words in this array [SEO, SEO Optimize, Ranking, Google Ranking, Search Rankings, AI, Generated by AI, Optimized by AI, Detectable, Not Detectable by AI] and must be in bullet format (use '*' character for each bullet point). remove rating, subpoints(summaries the subpoints and make it as one sentance) and not add any heading.
  must follow the rules like "use highly searched keywords that ranked on top of Google searches and are related to this product" and "the description has a maximum of 40 characters" and "the whole description is fully SEO optimized" and (MOST important.) "Rewrite the content so it is not detected as AI content by the AI content detector by following all key attribute that is undetectable being written by AI."`;
  messages.push({ role: "user", content: input }); 

  const requestPros = () =>
    openai.createChatCompletion({
      model: "gpt-4",
      messages: messages,
    }); 

  const completionPros = await handleExponentialBackoff(requestPros); 

  let pros = completionPros.data.choices[0].message.content; 

  messages = []; 

  // Generate cons from negative reviews
  input = `I have a array of my customers negative reviews ${allNegativeReviews}
  now write down the just valid cons or disadvantages of this products in points and not use any of these of words in this array [SEO, SEO Optimize, Ranking, Google Ranking, Search Rankings, AI, Generated by AI, Optimized by AI, Detectable, Not Detectable by AI], points are to the point and must be in bullet format (use '*' character for each bullet point). remove rating, subpoints(summaries the subpoints and make it as one sentance) and not add any heading. must follow the rules like "use highly searched keywords that ranked on top of Google searches and are related to this product" and "the description has a maximum of 40 characters" and "the whole description is fully SEO optimized" and (MOST important.) "Rewrite the content so it is not detected as AI content by the AI content detector by following all key attribute that is undetectable being written by AI."
    )}`;
  messages.push({ role: "user", content: input }); 

  const requestCons = () =>
    openai.createChatCompletion({
      model: "gpt-4",
      messages: messages,
    }); 

  const completionCons = await handleExponentialBackoff(requestCons); 

  let cons = completionCons.data.choices[0].message.content;
  return `${productSummary} Pros: ${pros} Cons: ${cons}`;
} 

// GENERATE META FOR SEO 

// GENERATE META DESCRIPTION
async function generateShortDes(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `Write short SEO optimized and highly searched keyword based description for ${keyword} for meta description `,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content.trim();
} 

// GENERATE META KEYWORDS
async function generateKeywords(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `give me top 100 comma saperated keywords for ${keyword} that is highly searched and SEO optimized`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content.trim();
} 

// GENERATE META KEYWORDS
async function generateSchema(keyword) {
  const messages = [
    { role: "user", content: keyword },
    {
      role: "assistant",
      content: `write a script tag for schema about ${keyword} must be seo optimized and highly chances for ranking`,
    },
  ]; 

  const completion = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
  }); 

  return completion.data.choices[0].message.content.trim();
} 

// Start the server
app.listen(5001, () => {
  console.log("Server is running on port New 5001");
});
