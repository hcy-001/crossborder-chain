---
updatedAt: 2026-09-10T20:03:07.000Z
agentTools:
  siteIndex: https://developer-docs.amazon/llms.txt
  projectIndex: https://developer-docs.amazon/sp-api/llms.txt
---

# Submit modular titles

Learn how to submit modular titles by using the `item_name` and `title_differentiation` (Item Highlights) attributes with the Listings Items API or the JSON_LISTINGS_FEED.

Learn how to submit product listings by using Amazon's modular title structure, which separates product titles into two components: `item_name` and `title_differentiation` (Item Highlights).

Modular titles are part of [Amazon's broader title policy update](https://sellercentral.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470). This guide focuses on how to implement modular titles through the API. To understand the full title requirements, formatting rules, and prohibited characters, refer to [Product title requirements and guidelines](https://sellercentral.amazon.com/help/hub/reference/external/GYTR6SYGFA5E3EQC?locale=en-US) on Seller Central.

> 📘 Note
>
> Starting July 27, 2026, this structure applies to all non-media product types submitted through the Listings Items API or the `JSON_LISTINGS_FEED`.

## Modular title attributes

| Attribute               | Purpose                                                     | Character limit      |
| ----------------------- | ----------------------------------------------------------- | -------------------- |
| `item_name`             | Core product identity (brand + product type + key feature). | Up to 75 characters  |
| `title_differentiation` | Comma-separated differentiating details (Item Highlights).  | Up to 125 characters |

The total character limit is 200 across both fields. You can only submit `title_differentiation` when `item_name` is 75 characters or fewer.

**How Item Highlights are displayed:** Item Highlights appear below titles in search results and on product detail pages. They are fully searchable, so customers can discover your product through the details you include in this field.

Follow these formatting rules:

* Write Item Highlights as comma-separated phrases, not full sentences.
* Focus on details that help customers compare options: materials, recommended use cases, compatibility, and key specifications.

The following example shows a single long title restructured into the modular format:

| Attribute               | Before (single long title)                                                                                                                                              | After (modular structure)              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `item_name`             | Fast Charger Adapter, PPS Supported, Compact Charger for models like MacBook Air/Macbook Pro/iPhone 14/iPhone 13/Galaxy S22/iPad Pro/Pixel and More, Cable Not Included | Fast Charger Adapter                   |
| `title_differentiation` | (not available)                                                                                                                                                         | USB-C, PPS Support, Cable not included |

> 📘 Note
>
> The formatting rules above cover API-specific guidance. For the full list of title DOs and DON'Ts, prohibited characters, category-specific style guides, and character limits by product type, refer to [Product title requirements and guidelines](https://sellercentral.amazon.com/help/hub/reference/external/GYTR6SYGFA5E3EQC?locale=en-US) on Seller Central.

## How the rollout works

**New and updated listings:** This change is effective starting July 27, 2026. We encourage you to use the modular structure for all listings created or updated after this date. However, you can still submit an `item_name` longer than 75 characters, and these submissions are accepted. Refer to [Automatic title splitting behavior](#automatic-title-splitting-behavior) to learn more.

**Existing listings:** This is a gradual rollout. This change does not affect your current listings unless you submit an update. You can adopt the modular structure at any time through 2026.

### Automatic title splitting behavior

If you submit an `item_name` longer than 75 characters (up to 200), Amazon may reconcile the value in the catalog, splitting it across `item_name` and `title_differentiation`. The [`getListingsItem`](https://developer-docs.amazon.com/sp-api/reference/getlistingsitem) and [`searchListingsItems`](https://developer-docs.amazon.com/sp-api/reference/searchlistingsitems) operations return your original submitted value, while the catalog shows Amazon's reconciled version.

## Prerequisites

To complete this tutorial, you need:

* Authorization from the selling partner for whom you are making calls. Refer to [Authorizing Selling Partner API Applications](https://developer-docs.amazon.com/sp-api/docs/authorizing-selling-partner-api-applications) for more information.
* Approval for the Product Listing role in your developer profile.
* The Product Listing role selected in the App registration page for your application.

## Step 1. Retrieve the product type schema

Use the [`getDefinitionsProductType`](https://developer-docs.amazon.com/sp-api/reference/getdefinitionsproducttype) operation to retrieve the schema for your product type. The response includes the `title_differentiation` attribute when it is available.

The following example requests the `PRODUCT` product type definition:

```
GET https://sellingpartnerapi-na.amazon.com/definitions/2020-09-01/productTypes/PRODUCT
    ?marketplaceIds=ATVPDKIKX0DER
    &locale=en_US
```

Look for `title_differentiation` in the schema's `product_identity` property group:

```json
{
  "title_differentiation": {
    "title": "Item Highlight",
    "description": "Provide product features or benefit driven phrases, not a full sentence. Information will appear only when the item name is under 75 characters. Do not repeat information already in the item name.",
    "examples": [
      "Breathable material"
    ],
    "type": "array",
    "minItems": 1,
    "minUniqueItems": 1,
    "maxUniqueItems": 1,
    "selectors": [
      "marketplace_id",
      "language_tag"
    ],
    "items": {
      "type": "object",
      "required": [
        "language_tag",
        "value"
      ],
      "properties": {
        "value": {
          "title": "Item Highlight",
          "description": "Provide product features or benefit driven phrases, not a full sentence. Information will appear only when the item name is under 75 characters. Do not repeat information already in the item name.",
          "editable": true,
          "hidden": false,
          "examples": [
            "Breathable material"
          ],
          "type": "string",
          "maxLength": 125
        },
        "language_tag": {
          "$ref": "#/$defs/language_tag"
        },
        "marketplace_id": {
          "$ref": "#/$defs/marketplace_id"
        }
      },
      "additionalProperties": false
    }
  }
}
```

> 🚧 Important
>
> If you provide Item Highlights (`title_differentiation`) for a listing, the `item_name` must be 75 characters or fewer.

## Step 2. Submit a listing with modular titles

Update your listing creation and update logic to submit `item_name` (75 characters or fewer) and `title_differentiation` (125 characters or fewer) as separate attributes.

> ⭐ Tip
>
> Use [validation preview](https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-use-case-guide#preview-errors-before-partially-updating-a-listing) mode to pre-validate the updated payload.

> 🚧 Important
>
> If you are using the `JSON_LISTINGS_FEED`, test the change on a small number of listings first before deploying it in production.

The following example updates a listing with `item_name` and `title_differentiation`:

```
PATCH https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{sku}
    ?marketplaceIds=ATVPDKIKX0DER
```

Request body:

```json
{
  "productType": "PRODUCT",
  "requirements": "LISTING",
  "attributes": {
    "item_name": [
      {
        "value": "Fast Charger Adapter",
        "language_tag": "en_US",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "title_differentiation": [
      {
        "value": "USB-C, PPS Support, Cable not included",
        "language_tag": "en_US",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ]
  }
}
```

### Error handling

If you submit `title_differentiation` when `item_name` exceeds 75 characters, the API returns the following error:

```json
"issues": [
  {
    "code": "100476",
    "message": "Provide an Item Name that is 75 characters or less to use Item Highlights. Additional details can be found in the tool tip.",
    "severity": "ERROR",
    "attributeNames": [
      "title_differentiation"
    ],
    "categories": [
      "INVALID_ATTRIBUTE"
    ],
    "enforcements": {
      "actions": [
        {
          "action": "ATTRIBUTE_SUPPRESSED"
        }
      ],
      "exemption": {
        "status": "NOT_EXEMPT"
      }
    }
  }
]
```

Error `100476` means that `item_name` exceeds 75 characters while `title_differentiation` is also present. To resolve this, trim or restructure `item_name` to 75 characters or fewer, then move the remaining differentiating details (materials, compatibility, and specifications) into `title_differentiation`.

For broader title compliance beyond character limits, such as prohibited characters, formatting rules, and category-specific restrictions that may cause listing suppression, refer to [Product title requirements and guidelines](https://sellercentral.amazon.com/help/hub/reference/external/GYTR6SYGFA5E3EQC?locale=en-US).

## Step 3. Validate the submission

Use the [`getListingsItem`](https://developer-docs.amazon.com/sp-api/reference/getlistingsitem) or [`searchListingsItems`](https://developer-docs.amazon.com/sp-api/reference/searchlistingsitems) operation to verify your submission for errors. The response returns the original submitted values for both `item_name` and `title_differentiation`.