package home

import (
	"log"

	"github.com/gofiber/fiber/v3"
	"github.com/svera/coreander/v4/internal/index"
	"github.com/svera/coreander/v4/internal/webserver/model"
)

func (d *Controller) Index(c fiber.Ctx) error {
	var session model.Session
	if val, ok := c.Locals("Session").(model.Session); ok {
		session = val
	}

	totalDocumentsCount, err := d.idx.Count()
	if err != nil {
		log.Println(err)
		return fiber.ErrInternalServerError
	}

	var allDocsRaw []index.Document
	if totalDocumentsCount > 0 {
		searchFields := index.SearchFields{
			SortBy: []string{"-AddedOn"},
		}
		res, err := d.idx.Search(searchFields, 1, int(totalDocumentsCount))
		if err != nil {
			log.Println(err)
			return fiber.ErrInternalServerError
		}
		allDocsRaw = res.Hits()
	}

	allDocs := make([]model.AugmentedDocument, 0, len(allDocsRaw))
	for _, doc := range allDocsRaw {
		allDocs = append(allDocs, model.AugmentedDocument{Document: doc})
	}

	var readingDocs []model.AugmentedDocument
	if session.ID > 0 {
		for i := range allDocs {
			result := model.AugmentedDocument{Document: allDocs[i].Document}
			result = d.hlRepository.Highlighted(int(session.ID), result)
			allDocs[i] = result
		}

		readingDocs, err = d.readingDocs(int(session.ID))
		if err != nil {
			log.Println(err)
			return fiber.ErrInternalServerError
		}
	}

	return c.Render("index", fiber.Map{
		"Count":      totalDocumentsCount,
		"EmailFrom":  d.sender.From(),
		"HomeNavbar": true,
		"AllDocs":    allDocs,
		"Reading":    readingDocs,
	}, "layout")
}
